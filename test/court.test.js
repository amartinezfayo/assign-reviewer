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
