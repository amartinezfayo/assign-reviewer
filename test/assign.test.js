const test = require('node:test');
const assert = require('node:assert/strict');
const assign = require('../lib/assign.js');
const { fakeGithub, fakeCore, pullRequest, assigneesOf, repo } = require('./fake_github.js');

const pool = ['alice', 'bob', 'carol'];
const review = (login) => ({ user: { login }, state: 'COMMENTED' });

function prEvent(action, extra = {}) {
  return {
    repo,
    eventName: 'pull_request_target',
    payload: { action, pull_request: { number: 1 }, ...extra },
  };
}

function commentEvent(login, { type = 'User', onPullRequest = true } = {}) {
  return {
    repo,
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      issue: { number: 1, ...(onPullRequest ? { pull_request: {} } : {}) },
      comment: { user: { login, type } },
    },
  };
}

test('assign', async (t) => {
  const tests = [
    {
      name: 'opened picks a pool member',
      pr: {}, context: prEvent('opened'), random: () => 0.5,
      want: ['bob'],
    },
    {
      name: 'opened never picks the author',
      pr: { author: 'bob' }, context: prEvent('opened'), random: () => 0.5,
      want: ['carol'],
    },
    {
      name: 'ready_for_review picks a pool member',
      pr: {}, context: prEvent('ready_for_review'), random: () => 0,
      want: ['alice'],
    },
    {
      name: 'draft is left alone',
      pr: { draft: true }, context: prEvent('opened'),
      want: [],
    },
    {
      name: 'bot author is left alone',
      pr: { user: { login: 'dependabot[bot]', type: 'Bot' } }, context: prEvent('opened'),
      want: [],
    },
    {
      name: 'review request moves the ball off the author',
      pr: { assignees: ['contributor'] },
      context: prEvent('review_requested', { requested_reviewer: { login: 'carol', type: 'User' } }),
      want: ['carol'],
    },
    {
      name: 'review request does not override the rotation',
      pr: { assignees: ['alice'] },
      context: prEvent('review_requested', { requested_reviewer: { login: 'carol', type: 'User' } }),
      want: ['alice'],
    },
    {
      name: 'review request for an outsider is ignored',
      pr: { assignees: ['contributor'] },
      context: prEvent('review_requested', { requested_reviewer: { login: 'outsider', type: 'User' } }),
      want: ['contributor'],
    },
    {
      name: 'push by the holding author returns the ball to the last reviewer',
      pr: { assignees: ['contributor'] }, reviews: [review('alice'), review('bob')],
      context: prEvent('synchronize'),
      want: ['bob'],
    },
    {
      name: 'push before any review changes nothing',
      pr: { assignees: ['contributor'] },
      context: prEvent('synchronize'),
      want: ['contributor'],
    },
    {
      name: 'push while a maintainer holds the ball changes nothing',
      pr: { assignees: ['alice'] }, reviews: [review('bob')],
      context: prEvent('synchronize'),
      want: ['alice'],
    },
    {
      name: 'comment by the holding maintainer moves the ball to the author',
      pr: { assignees: ['alice'] },
      context: commentEvent('alice'),
      want: ['contributor'],
    },
    {
      name: 'comment by the holding author returns the ball to the last reviewer',
      pr: { assignees: ['contributor'] }, reviews: [review('carol')],
      context: commentEvent('contributor'),
      want: ['carol'],
    },
    {
      name: 'comment by somebody not holding the ball changes nothing',
      pr: { assignees: ['alice'] },
      context: commentEvent('contributor'),
      want: ['alice'],
    },
    {
      name: 'comment by a bot changes nothing',
      pr: { assignees: ['alice'] },
      context: commentEvent('alice', { type: 'Bot' }),
      want: ['alice'],
    },
    {
      name: 'comment on a closed pull request changes nothing',
      pr: { assignees: ['alice'], state: 'closed' },
      context: commentEvent('alice'),
      want: ['alice'],
    },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const pr = pullRequest(tt.pr);
      const github = fakeGithub({ pool, prs: [pr], reviews: { 1: tt.reviews || [] } });
      await assign({ github, context: tt.context, core: fakeCore(), random: tt.random });
      assert.deepEqual(assigneesOf(pr), tt.want);
    });
  }
});

test('assign ignores comments on plain issues', async () => {
  // No pull request exists, so any lookup would throw.
  const github = fakeGithub({ pool, prs: [] });
  await assign({
    github, context: commentEvent('alice', { onPullRequest: false }), core: fakeCore(),
  });
});
