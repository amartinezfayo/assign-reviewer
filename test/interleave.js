// Runs concurrent tasks under every possible ordering of their API calls.
//
// Each task gets its own view of the fake API whose calls wait for a turn.
// The explorer releases one waiting call at a time and replays the tasks
// from scratch for each ordering, depth first, until none is left.

// A view of `github` whose REST calls each wait for `turn` first.
function gated(github, turn) {
  const rest = {};
  for (const [area, methods] of Object.entries(github.rest)) {
    rest[area] = {};
    for (const [name, method] of Object.entries(methods)) {
      rest[area][name] = async (params) => {
        await turn();
        return method(params);
      };
    }
  }
  return { rest, paginate: github.paginate };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// Runs one ordering. `setup` builds a fresh world and returns one function
// per task, each taking the `gate` that wraps a github object for it.
// `schedule[step]` picks which waiting task moves at that step, and tasks
// beyond its end move in index order. Returns how many tasks were waiting
// at each step, which is what the caller needs to find the next ordering.
async function runOrdering(setup, schedule) {
  const waiting = new Map();
  const { tasks, finish } = await setup((github, index) =>
    gated(github, () => new Promise(resolve => waiting.set(index, resolve))));

  let running = tasks.length;
  const runs = tasks.map(task => task().finally(() => { running--; }));
  const width = [];
  while (running > 0) {
    // The fake API does no real I/O, so one tick lets every released
    // task reach its next call or finish.
    await tick();
    const ready = [...waiting.keys()].sort((a, b) => a - b);
    if (ready.length === 0) {
      continue;
    }
    const index = ready[schedule[width.length] ?? 0];
    width.push(ready.length);
    const release = waiting.get(index);
    waiting.delete(index);
    release();
  }
  await Promise.all(runs);
  await finish(schedule);
  return width;
}

// Calls `setup` and runs its tasks once per possible ordering. Returns the
// number of orderings explored.
async function everyOrdering(setup) {
  let schedule = [];
  for (let count = 1; ; count++) {
    const width = await runOrdering(setup, schedule);
    const taken = width.map((_, step) => schedule[step] ?? 0);
    let step = taken.length - 1;
    while (step >= 0 && taken[step] + 1 >= width[step]) {
      step--;
    }
    if (step < 0) {
      return count;
    }
    schedule = [...taken.slice(0, step), taken[step] + 1];
  }
}

module.exports = { everyOrdering };
