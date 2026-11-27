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

  // The login that sorts first ignoring case, or null for an empty list.
  // It is the tie-break every concurrent writer applies, so they agree.
  function lowestLogin(logins) {
    return logins.reduce((lowest, a) =>
      lowest === null || a.toLowerCase() < lowest.toLowerCase() ? a : lowest, null);
  }

  // Make `login` the sole ball-in-court assignee among flow participants
  // (the pool members and the PR author), leaving any unrelated,
  // manually-added assignees untouched.
  //
  // The new holder is added before the previous one is removed, and the
  // assignees are read back in between. GitHub drops a login it cannot
  // assign without reporting an error, and removing first would then
  // leave the court empty.
  //
  // Handlers for different events run concurrently, so two of them can
  // act on the same snapshot and each add its own target, which would
  // leave a court that courtHolder reports as ambiguous from then on.
  // When the read-back shows a holder that was not in the snapshot,
  // every writer keeps the same one (the lowest login) and removes the
  // rest. Whichever writer reads last sees all of them, so the court
  // ends with a single holder.
  async function setCourt(pr, login) {
    const inFlow = (a) => inPool(a) || eq(a, pr.user.login);
    const previous = (pr.assignees || []).map(a => a.login)
      .filter(a => inFlow(a) && !eq(a, login));
    await github.rest.issues.addAssignees({
      owner, repo, issue_number: pr.number, assignees: [login],
    });

    const { data: written } = await github.rest.pulls.get({
      owner, repo, pull_number: pr.number,
    });
    const holders = (written.assignees || []).map(a => a.login).filter(inFlow);
    if (!holders.some(a => eq(a, login))) {
      core.warning(`GitHub did not assign ${login} on PR #${pr.number}, leaving court unchanged.`);
      return;
    }

    const wasHolder = (a) => previous.some(p => eq(p, a));
    const kept = lowestLogin(holders.filter(a => !wasHolder(a)));
    if (!eq(kept, login)) {
      core.info(`A concurrent run also moved the court on PR #${pr.number}, keeping ${kept}.`);
    }
    const toRemove = holders.filter(a => !eq(a, kept));
    if (toRemove.length > 0) {
      await github.rest.issues.removeAssignees({
        owner, repo, issue_number: pr.number, assignees: toRemove,
      });
    }
    core.info(`Ball in court on PR #${pr.number} is now with ${kept}.`);
  }

  return { pool, eq, inPool, isBot, courtHolder, lastPoolReviewer, setCourt };
};
