const test = require('node:test');
const assert = require('node:assert/strict');
const loadCourt = require('../lib/court.js');
const { fakeGithub, fakeCore, pullRequest, assigneesOf, repo } = require('./fake_github.js');
const { everyOrdering, sampleOrderings } = require('./interleave.js');

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

// Each run holds its own copy of the pull request as it was before either
// wrote, the way two concurrent handlers do.
test('setCourt lets the run that writes last win', async (t) => {
  const tests = [
    { name: 'bob then carol', order: ['bob', 'carol'], want: ['outsider', 'carol'] },
    { name: 'carol then bob', order: ['carol', 'bob'], want: ['outsider', 'bob'] },
    { name: 'the author then carol', order: ['contributor', 'carol'], assignees: ['bob'], want: ['carol'] },
    { name: 'carol then the author', order: ['carol', 'contributor'], assignees: ['bob'], want: ['contributor'] },
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
      assert.deepEqual(assigneesOf(pr), tt.want);
    });
  }
});

test('setCourt falls back to the lowest login when the event list names no holder', async (t) => {
  for (const order of [['bob', 'carol'], ['carol', 'bob']]) {
    await t.test(order.join(' then '), async () => {
      const pr = pullRequest({ assignees: ['contributor'] });
      const github = fakeGithub({ pool, prs: [pr] });
      github.rest.issues.listEvents = async () => ({ data: [] });
      const court = await loadCourt({ github, context: { repo }, core: fakeCore() });
      const snapshots = order.map(() => structuredClone(pr));
      for (const [i, login] of order.entries()) {
        await court.setCourt(snapshots[i], login);
      }
      assert.deepEqual(assigneesOf(pr), ['bob']);
    });
  }
});

// A view of `github` whose event list misses the newest `steps` events,
// the way the events API can trail the assignees for a moment.
function withEventsBehind(github, steps) {
  const { listEvents } = github.rest.issues;
  github.rest.issues.listEvents = async (params) => {
    const { data } = await listEvents(params);
    return { data: data.slice(0, Math.max(0, data.length - steps)) };
  };
}

// Tries the API calls of concurrent setCourt runs in every possible
// order. The runs start from the same snapshot. Whatever the order, the
// court must end with one flow participant, and the outsider must stay
// assigned. `behind` holds, per run, how many events its list trails by.
async function assertSettlesUnderEveryOrdering({ author = 'contributor', assignees, targets, behind = [] }) {
  const orderings = await everyOrdering(async (gate) => {
    const pr = pullRequest({ author, assignees: [...assignees, 'outsider'] });
    const github = fakeGithub({ pool, prs: [pr] });
    const snapshot = structuredClone(pr);
    const tasks = [];
    for (const [i, login] of targets.entries()) {
      // The pool is loaded before the calls start taking turns.
      const view = { ...github };
      const court = await loadCourt({ github: view, context: { repo }, core: fakeCore() });
      Object.assign(view, gate(github, i));
      withEventsBehind(view, behind[i] ?? 0);
      tasks.push(() => court.setCourt(structuredClone(snapshot), login));
    }
    const finish = (schedule) => {
      const holders = assigneesOf(pr).filter(a => a !== 'outsider');
      assert.equal(holders.length, 1,
        `ordering [${schedule}] ended with [${assigneesOf(pr)}]`);
      assert.ok(targets.includes(holders[0]),
        `ordering [${schedule}] ended with ${holders[0]}`);
      assert.ok(assigneesOf(pr).includes('outsider'),
        `ordering [${schedule}] removed the outsider`);
    };
    return { tasks, finish };
  });
  assert.ok(orderings > 1, 'expected more than one ordering');
}

const concurrentRuns = [
  { name: 'two runs move to different reviewers', assignees: ['contributor'], targets: ['bob', 'carol'] },
  { name: 'two runs move to the same reviewer', assignees: ['contributor'], targets: ['carol', 'carol'] },
  { name: 'one run keeps the reviewer, one moves to an author sorting after', author: 'zed', assignees: ['bob'], targets: ['bob', 'zed'] },
  { name: 'one run keeps the reviewer, one moves to an author sorting before', author: 'aaron', assignees: ['bob'], targets: ['bob', 'aaron'] },
  { name: 'one run keeps the author, one moves to a reviewer sorting after', author: 'aaron', assignees: ['aaron'], targets: ['aaron', 'carol'] },
  { name: 'one run keeps the author, one moves to a reviewer sorting before', author: 'zed', assignees: ['zed'], targets: ['zed', 'alice'] },
  { name: 'a reviewer and the author swap', assignees: ['bob'], targets: ['contributor', 'carol'] },
  { name: 'nobody holds the ball yet', assignees: [], targets: ['alice', 'bob'] },
];

test('setCourt ends with a single holder under every ordering of concurrent runs', async (t) => {
  for (const tt of concurrentRuns) {
    await t.test(tt.name, () => assertSettlesUnderEveryOrdering(tt));
  }
});

// The runs can then disagree on who was assigned last, so each would
// keep a different holder.
test('setCourt ends with a single holder when one run reads an event list that is behind', async (t) => {
  for (const tt of concurrentRuns) {
    for (const behind of [[1, 0], [0, 1], [2, 0], [0, 2]]) {
      await t.test(`${tt.name}, behind by ${behind}`, () =>
        assertSettlesUnderEveryOrdering({ ...tt, behind }));
    }
  }
});

// Three runs have too many orderings to try them all, and they can use up
// the settle rounds, so the guarantee checked here is the weaker one that
// always holds. The court never ends up empty, and it ends with a single
// holder whenever no run reported giving up.
test('setCourt never empties the court under sampled orderings of three runs', async () => {
  const targets = ['contributor', 'bob', 'carol'];
  let orderings = 0;
  await sampleOrderings(async (gate) => {
    const pr = pullRequest({ assignees: ['contributor', 'outsider'] });
    const github = fakeGithub({ pool, prs: [pr] });
    const snapshot = structuredClone(pr);
    const cores = [];
    const tasks = [];
    for (const [i, login] of targets.entries()) {
      const view = { ...github };
      const core = fakeCore();
      cores.push(core);
      const court = await loadCourt({ github: view, context: { repo }, core });
      Object.assign(view, gate(github, i));
      tasks.push(() => court.setCourt(structuredClone(snapshot), login));
    }
    const finish = (taken) => {
      orderings++;
      const holders = assigneesOf(pr).filter(a => a !== 'outsider');
      const gaveUp = cores.some(c => c.warnings.length > 0);
      assert.ok(holders.length >= 1, `ordering [${taken}] emptied the court`);
      assert.ok(holders.length === 1 || gaveUp,
        `ordering [${taken}] ended with [${holders}] and no warning`);
      assert.ok(assigneesOf(pr).includes('outsider'),
        `ordering [${taken}] removed the outsider`);
    };
    return { tasks, finish };
  }, 3000, 20261127);
  assert.equal(orderings, 3000);
});

// Another run keeps putting back whoever this run removes, so the court
// never settles. The run must stop on a read, since a removal that nobody
// checks afterwards is what can leave the court empty.
test('setCourt does not end on a removal when the court never settles', async () => {
  const pr = pullRequest({ assignees: ['contributor', 'outsider'] });
  const github = fakeGithub({ pool, prs: [pr] });
  const calls = [];
  for (const [area, methods] of Object.entries(github.rest)) {
    for (const [name, method] of Object.entries(methods)) {
      github.rest[area][name] = async (params) => {
        calls.push(`${area}.${name}`);
        return method(params);
      };
    }
  }
  const remove = github.rest.issues.removeAssignees;
  github.rest.issues.removeAssignees = async (params) => {
    await remove(params);
    pr.assignees = [...pr.assignees, ...params.assignees.map(login => ({ login }))];
  };
  const core = fakeCore();
  const court = await loadCourt({ github, context: { repo }, core });
  const snapshot = structuredClone(pr);
  pr.assignees.push({ login: 'carol' });

  await court.setCourt(snapshot, 'bob');

  assert.equal(calls.at(-1), 'pulls.get');
  assert.deepEqual(core.warnings,
    ['The court on PR #1 did not settle on a single assignee.']);
  assert.ok(assigneesOf(pr).some(a => a !== 'outsider'));
});

// Another run removes this run's target right after every assignment but
// the last one. The assignment that follows the last round is read back
// like the others, so the run reports the holder instead of giving up.
test('setCourt reads the court again after the last assignment', async () => {
  const pr = pullRequest({ assignees: ['contributor', 'outsider'] });
  const github = fakeGithub({ pool, prs: [pr] });
  const calls = [];
  for (const [area, methods] of Object.entries(github.rest)) {
    for (const [name, method] of Object.entries(methods)) {
      github.rest[area][name] = async (params) => {
        calls.push(`${area}.${name}`);
        return method(params);
      };
    }
  }
  const remove = github.rest.issues.removeAssignees;
  github.rest.issues.removeAssignees = async (params) => {
    await remove(params);
    pr.assignees = pr.assignees.filter(a => a.login !== 'bob');
  };
  const add = github.rest.issues.addAssignees;
  let undone = 0;
  github.rest.issues.addAssignees = async (params) => {
    await add(params);
    // The first assignment is the move itself, which setCourt reads back
    // before the settle step starts.
    if (calls.filter(c => c === 'issues.addAssignees').length > 1 && undone < 5) {
      undone++;
      pr.assignees = pr.assignees.filter(a => a.login !== 'bob');
    }
  };
  const core = fakeCore();
  const court = await loadCourt({ github, context: { repo }, core });

  await court.setCourt(structuredClone(pr), 'bob');

  assert.equal(undone, 5);
  assert.deepEqual(calls.slice(-2), ['issues.addAssignees', 'pulls.get']);
  assert.deepEqual(core.warnings, []);
  assert.equal(core.infos.at(-1), 'Ball in court on PR #1 is now with bob.');
  assert.deepEqual(assigneesOf(pr), ['outsider', 'bob']);
});

test('setCourt leaves the court alone when GitHub does not assign the login', async () => {
  const pr = pullRequest({ assignees: ['bob', 'outsider'] });
  const github = fakeGithub({ pool, prs: [pr], unassignable: ['contributor'] });
  const core = fakeCore();
  const court = await loadCourt({ github, context: { repo }, core });
  await court.setCourt(pr, 'contributor');
  assert.deepEqual(assigneesOf(pr), ['bob', 'outsider']);
  assert.deepEqual(core.warnings,
    ['contributor is not assigned on PR #1 after being added, leaving court unchanged.']);
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
