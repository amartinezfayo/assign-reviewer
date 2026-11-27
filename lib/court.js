// Shared ball-in-court helpers for the assign, apply and reconcile actions.
//
// The ball is tracked through the PR assignee. The court holder is the
// single flow participant (a pool member or the PR author) currently
// assigned. Activity-driven flips depend on who holds the ball. A
// conversation comment or a review reply only flips it when the person
// who wrote it holds it. A push or a review re-request only flips it when
// the PR author holds it, whoever pushed or made the request. Repeated
// events are therefore no-ops and those flips never override a manual
// assignee change. The initial assignment on open and the flips on
// pool-member review submissions move the court unconditionally, and
// setCourt only ever touches flow participants, leaving unrelated,
// manually-added assignees in place.
//
// This file ships inside the action, so it is loaded at the ref the
// calling workflow pins and never from PR code.

const poolPath = '.github/reviewer-pool.json';

// How many rounds setCourt takes to settle a race, each one a write
// followed by a read.
const settleRounds = 5;

// Every opting repository writes the pool file by hand, so a mistake in
// it is reported by name instead of surfacing as a type error later.
function parsePool(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${poolPath} is not valid JSON, ${e.message}`);
  }
  const reviewers = parsed?.reviewers;
  if (!Array.isArray(reviewers) ||
      !reviewers.every(r => typeof r === 'string' && r !== '')) {
    throw new Error(`${poolPath} must hold a "reviewers" list of logins.`);
  }
  return reviewers;
}

module.exports = async function ({ github, context, core }) {
  const { owner, repo } = context.repo;
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

  // The reviewer pool lives in the calling repository so each project
  // keeps its own. Read it from the default branch (the API default ref)
  // so a PR from a fork cannot substitute its own pool.
  const { data: poolFile } = await github.rest.repos.getContent({
    owner, repo, path: poolPath,
  });
  const pool = parsePool(
    Buffer.from(poolFile.content, poolFile.encoding).toString('utf8'));

  const inPool = (login) => pool.some(p => eq(p, login));

  const isBot = (user) =>
    user.type === 'Bot' || user.login.endsWith('[bot]');

  // The flow participant currently holding the ball, or null when no
  // participant is assigned or the state is ambiguous (for example, a
  // manually co-assigned maintainer next to the author). Handlers treat
  // null as "do not touch".
  function courtHolder(pr) {
    const author = pr.user.login;
    const assigned = (pr.assignees || []).map(a => a.login);
    const maintainers = assigned.filter(a => inPool(a) && !eq(a, author));
    const authorAssigned = assigned.some(a => eq(a, author));
    if (authorAssigned && maintainers.length === 0) {
      return author;
    }
    if (!authorAssigned && maintainers.length === 1) {
      return maintainers[0];
    }
    return null;
  }

  // The pool member (other than the author) who most recently submitted a
  // review, or null when nobody from the pool has reviewed yet. Used as
  // the flip-back target when the author acts without re-requesting a
  // review. Callers that already listed the PR's reviews can pass them to
  // skip the refetch.
  async function lastPoolReviewer(pr, reviews = null) {
    reviews ??= await github.paginate(github.rest.pulls.listReviews, {
      owner, repo, pull_number: pr.number, per_page: 100,
    });
    for (let i = reviews.length - 1; i >= 0; i--) {
      const login = reviews[i].user && reviews[i].user.login;
      if (login && inPool(login) && !eq(login, pr.user.login)) {
        return login;
      }
    }
    return null;
  }

  // The login that sorts first ignoring case. `logins` must not be empty,
  // and both callers pass two or more holders.
  function lowestLogin(logins) {
    return logins.reduce((lowest, a) =>
      a.toLowerCase() < lowest.toLowerCase() ? a : lowest);
  }

  const inFlow = (pr, login) => inPool(login) || eq(login, pr.user.login);

  // The flow participants assigned right now, from a fresh fetch.
  async function fetchHolders(pr) {
    const { data: current } = await github.rest.pulls.get({
      owner, repo, pull_number: pr.number,
    });
    return (current.assignees || []).map(a => a.login)
      .filter(a => inFlow(pr, a));
  }

  // Of `holders`, the one assigned most recently, or the lowest login
  // when the event list names none of them.
  //
  // Adding a login that is already assigned records no event. A run that
  // keeps the current holder therefore loses to a run that moves the
  // ball, whichever of the two events happened first. That is accepted,
  // because the events cannot order a keep against a move.
  async function lastAssigned(pr, holders) {
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner, repo, issue_number: pr.number, per_page: 100,
    });
    const isHolder = (e) =>
      e.assignee && holders.some(h => eq(h, e.assignee.login));
    const latest = events.findLast(e => e.event === 'assigned' && isHolder(e));
    return latest
      ? holders.find(h => eq(h, latest.assignee.login))
      : lowestLogin(holders);
  }

  async function addAssignee(pr, login) {
    await github.rest.issues.addAssignees({
      owner, repo, issue_number: pr.number, assignees: [login],
    });
  }

  async function removeAssignees(pr, logins) {
    if (logins.length > 0) {
      await github.rest.issues.removeAssignees({
        owner, repo, issue_number: pr.number, assignees: logins,
      });
    }
  }

  // Bring the court to a single holder after a move. Handlers for
  // different events run concurrently, so two of them can act on the same
  // snapshot and leave two holders, which courtHolder reports as
  // ambiguous from then on, or remove each other's and leave none.
  //
  // Each round decides from the assignees as they are now, never from the
  // snapshot. With none, `login` is assigned again. With several, one
  // stays. The first round keeps the most recently assigned one, so the
  // run that wrote last wins. The events API can trail the assignees,
  // though, and two runs reading different event lists would each keep a
  // different holder. If the first round did not settle the court, the
  // later ones keep the lowest login instead, which every run derives
  // from the assignees alone.
  //
  // Every write is followed by a read. A removal can cross with another
  // run's and leave the court empty, and the read is what notices. That
  // includes the last round, so the final write of all the runs together
  // is either an assignment or a removal that its own run then checked,
  // and the court cannot end up empty. Running out of rounds can leave
  // several holders, which is reported.
  async function settleCourt(pr, login) {
    let holders = await fetchHolders(pr);
    for (let round = 0; round < settleRounds && holders.length !== 1; round++) {
      if (holders.length === 0) {
        await addAssignee(pr, login);
      } else {
        const kept = round === 0
          ? await lastAssigned(pr, holders)
          : lowestLogin(holders);
        core.info(`A concurrent run also moved the court on PR #${pr.number}, keeping ${kept}.`);
        await removeAssignees(pr, holders.filter(a => !eq(a, kept)));
      }
      holders = await fetchHolders(pr);
    }
    if (holders.length === 0) {
      await addAssignee(pr, login);
      holders = await fetchHolders(pr);
    }
    if (holders.length !== 1) {
      core.warning(`The court on PR #${pr.number} did not settle on a single assignee.`);
      return;
    }
    core.info(`Ball in court on PR #${pr.number} is now with ${holders[0]}.`);
  }

  // Make `login` the sole ball-in-court assignee among flow participants
  // (the pool members and the PR author), leaving any unrelated,
  // manually-added assignees untouched.
  //
  // The new holder is added before the previous one is removed, and the
  // assignees are read back in between. GitHub drops a login it cannot
  // assign without reporting an error, and removing first would then
  // leave the court empty.
  async function setCourt(pr, login) {
    const previous = (pr.assignees || []).map(a => a.login)
      .filter(a => inFlow(pr, a) && !eq(a, login));
    await addAssignee(pr, login);

    const holders = await fetchHolders(pr);
    if (!holders.some(a => eq(a, login))) {
      core.warning(`${login} is not assigned on PR #${pr.number} after being added, leaving court unchanged.`);
      return;
    }
    await removeAssignees(pr, holders.filter(a =>
      previous.some(p => eq(p, a))));
    await settleCourt(pr, login);
  }

  return { pool, eq, inPool, isBot, courtHolder, lastPoolReviewer, setCourt };
};
