const test = require('node:test');
const assert = require('node:assert/strict');
const reconcile = require('../lib/reconcile.js');
const { fakeGithub, fakeCore, pullRequest, assigneesOf, repo } = require('./fake_github.js');

const pool = ['alice', 'bob', 'carol'];
const context = { repo };

// Every timestamp derives from one instant so the window maths is stable.
const nowMs = Date.parse('2026-11-26T12:00:00Z');
const at = (hoursAgo) => new Date(nowMs - hoursAgo * 60 * 60 * 1000).toISOString();
const review = (login, state, hoursAgo, commit_id = 'head-sha') =>
  ({ user: { login }, state, submitted_at: at(hoursAgo), commit_id });
const bot = { login: 'github-actions[bot]', type: 'Bot' };

test('reconcile', async (t) => {
  const tests = [
    {
      name: 'dropped approval moves the ball to the reviewer',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 1)],
      want: ['bob'],
    },
    {
      name: 'dropped author replies return the ball to the last reviewer',
      pr: { assignees: ['contributor'] },
      reviews: [review('carol', 'COMMENTED', 3), review('contributor', 'COMMENTED', 1)],
      want: ['carol'],
    },
    {
      name: 'dropped changes requested moves the ball to the author',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'CHANGES_REQUESTED', 1)],
      want: ['contributor'],
    },
    {
      name: 'an applied transition is left alone',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'APPROVED', 1)],
      want: ['bob'],
    },
    {
      name: 'a push after the review stands the pass down',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 1, 'older-sha')],
      want: ['contributor'],
    },
    {
      name: 'a review pending from the holder stands the pass down',
      pr: { assignees: ['bob'], requested_reviewers: [{ login: 'bob' }] },
      reviews: [review('bob', 'CHANGES_REQUESTED', 1)],
      want: ['bob'],
    },
    {
      name: 'a manual assignee change after the review is respected',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 2)],
      events: [{
        event: 'assigned', created_at: at(1),
        assigner: { login: 'alice', type: 'User' }, assignee: { login: 'contributor' },
      }],
      want: ['contributor'],
    },
    {
      name: 'a late handler assigning the stale holder is corrected',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 2)],
      events: [{
        event: 'assigned', created_at: at(1),
        assigner: bot, assignee: { login: 'contributor' },
      }],
      want: ['bob'],
    },
    {
      name: 'a comment by the target after the review explains the late handler',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 2)],
      events: [{
        event: 'assigned', created_at: at(1),
        assigner: bot, assignee: { login: 'contributor' },
      }],
      comments: [{ user: { login: 'bob' }, created_at: at(1) }],
      want: ['contributor'],
    },
    {
      name: 'a review older than the window is skipped by a scheduled pass',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 30)],
      want: ['contributor'],
    },
    {
      name: 'a dispatch ignores the window',
      pr: { assignees: ['contributor'] },
      reviews: [review('bob', 'APPROVED', 30)],
      requested: '1',
      want: ['bob'],
    },
    {
      name: 'a pull request not updated inside the window is not visited',
      pr: { assignees: ['contributor'], updated_at: at(30) },
      reviews: [review('bob', 'APPROVED', 1)],
      want: ['contributor'],
    },
    {
      name: 'a draft is left alone',
      pr: { assignees: ['contributor'], draft: true },
      reviews: [review('bob', 'APPROVED', 1)],
      want: ['contributor'],
    },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const pr = pullRequest({ updated_at: at(0), ...tt.pr });
      const github = fakeGithub({
        pool, prs: [pr],
        reviews: { 1: tt.reviews },
        events: { 1: tt.events || [] },
        comments: { 1: tt.comments || [] },
      });
      const core = fakeCore();
      await reconcile({ github, context, core, requested: tt.requested, now: () => nowMs });
      assert.deepEqual(assigneesOf(pr), tt.want);
      assert.deepEqual(core.failures, []);
    });
  }
});

test('reconcile rejects a dispatch input that is not a positive integer', async () => {
  const pr = pullRequest({ assignees: ['contributor'], updated_at: at(0) });
  const github = fakeGithub({ pool, prs: [pr], reviews: { 1: [review('bob', 'APPROVED', 1)] } });
  const core = fakeCore();
  await reconcile({ github, context, core, requested: '1 OR 2', now: () => nowMs });
  assert.deepEqual(assigneesOf(pr), ['contributor']);
  assert.equal(core.failures.length, 1);
});
