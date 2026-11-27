const test = require('node:test');
const assert = require('node:assert/strict');
const loadCourt = require('../lib/court.js');
const { fakeGithub, fakeCore, pullRequest, assigneesOf, repo } = require('./fake_github.js');

const pool = ['alice', 'bob', 'carol'];

async function courtFor(prs, reviews = {}) {
  const github = fakeGithub({ pool, prs, reviews });
  return loadCourt({ github, context: { repo }, core: fakeCore() });
}

test('courtHolder', async (t) => {
  const tests = [
    { name: 'nobody assigned', assignees: [], want: null },
    { name: 'author alone', assignees: ['contributor'], want: 'contributor' },
    { name: 'one maintainer alone', assignees: ['bob'], want: 'bob' },
    { name: 'login case is ignored', assignees: ['BOB'], want: 'BOB' },
    { name: 'author next to a maintainer', assignees: ['contributor', 'bob'], want: null },
    { name: 'two maintainers', assignees: ['alice', 'bob'], want: null },
    { name: 'outsider next to a maintainer', assignees: ['outsider', 'bob'], want: 'bob' },
    { name: 'outsider alone', assignees: ['outsider'], want: null },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const pr = pullRequest({ assignees: tt.assignees });
      const court = await courtFor([pr]);
      assert.equal(court.courtHolder(pr), tt.want);
    });
  }
});

test('courtHolder treats a maintainer author as the author', async () => {
  const pr = pullRequest({ author: 'alice', assignees: ['alice'] });
  const court = await courtFor([pr]);
  assert.equal(court.courtHolder(pr), 'alice');
});

test('lastPoolReviewer', async (t) => {
  const review = (login) => ({ user: { login }, state: 'COMMENTED' });
  const tests = [
    { name: 'no reviews', reviews: [], want: null },
    { name: 'only outsiders and the author', reviews: [review('outsider'), review('contributor')], want: null },
    { name: 'latest pool member wins', reviews: [review('alice'), review('bob'), review('outsider')], want: 'bob' },
    { name: 'deleted user is skipped', reviews: [review('alice'), { user: null, state: 'COMMENTED' }], want: 'alice' },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const pr = pullRequest({});
      const court = await courtFor([pr], { 1: tt.reviews });
      assert.equal(await court.lastPoolReviewer(pr), tt.want);
    });
  }
});

test('setCourt replaces flow participants and keeps other assignees', async () => {
  const pr = pullRequest({ assignees: ['contributor', 'alice', 'outsider'] });
  const court = await courtFor([pr]);
  await court.setCourt(pr, 'bob');
  assert.deepEqual(assigneesOf(pr), ['outsider', 'bob']);
});

test('setCourt converges when two runs write from the same snapshot', async (t) => {
  // Each run holds its own copy of the pull request as it was before
  // either wrote, the way two concurrent handlers do.
  const tests = [
    { name: 'the lowest login writes first', order: ['bob', 'carol'] },
    { name: 'the lowest login writes last', order: ['carol', 'bob'] },
    { name: 'one run hands the ball to the author', order: ['contributor', 'carol'], assignees: ['bob'], want: ['carol'] },
    { name: 'both runs pick the same login', order: ['carol', 'carol'], want: ['outsider', 'carol'] },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const pr = pullRequest({ assignees: tt.assignees ?? ['contributor', 'outsider'] });
      const court = await courtFor([pr]);
      const snapshots = tt.order.map(() => structuredClone(pr));
      for (const [i, login] of tt.order.entries()) {
        await court.setCourt(snapshots[i], login);
      }
      assert.deepEqual(assigneesOf(pr), tt.want ?? ['outsider', 'bob']);
    });
  }
});

test('setCourt leaves the court alone when GitHub does not assign the login', async () => {
  const pr = pullRequest({ assignees: ['bob', 'outsider'] });
  const github = fakeGithub({ pool, prs: [pr], unassignable: ['contributor'] });
  const core = fakeCore();
  const court = await loadCourt({ github, context: { repo }, core });
  await court.setCourt(pr, 'contributor');
  assert.deepEqual(assigneesOf(pr), ['bob', 'outsider']);
  assert.deepEqual(core.warnings,
    ['GitHub did not assign contributor on PR #1, leaving court unchanged.']);
});

test('a malformed pool file is reported by name', async (t) => {
  const tests = [
    { name: 'not JSON', poolFile: 'oops', want: /reviewer-pool\.json is not valid JSON/ },
    { name: 'not an object', poolFile: 'null', want: /must hold a "reviewers" list/ },
    { name: 'no reviewers list', poolFile: '{}', want: /reviewer-pool\.json must hold a "reviewers" list/ },
    { name: 'reviewers is not a list', poolFile: '{"reviewers":"bob"}', want: /must hold a "reviewers" list/ },
    { name: 'an entry is not a login', poolFile: '{"reviewers":["bob",7]}', want: /must hold a "reviewers" list/ },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async () => {
      const github = fakeGithub({ pool, prs: [], poolFile: tt.poolFile });
      await assert.rejects(
        loadCourt({ github, context: { repo }, core: fakeCore() }), tt.want);
    });
  }
});
