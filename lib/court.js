// Shared ball-in-court helpers for the assign, apply and reconcile actions.
//
// The ball is tracked through the PR assignee. The court holder is the
// single flow participant (a pool member or the PR author) currently
// assigned. Activity-driven flips (pushes, conversation comments, the
// author's review replies) only happen when the acting user holds the
// ball, so repeated events are no-ops and those flips never override a
// manual assignee change. The initial assignment on open and the flips on
// pool-member review submissions move the court unconditionally, and
// setCourt only ever touches flow participants, leaving unrelated,
// manually-added assignees in place.
//
// This file ships inside the action, so it is loaded at the ref the
// calling workflow pins and never from PR code.

const poolPath = '.github/reviewer-pool.json';

module.exports = async function ({ github, context, core }) {
  const { owner, repo } = context.repo;
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

  // The reviewer pool lives in the calling repository so each project
  // keeps its own. Read it from the default branch (the API default ref)
  // so a PR from a fork cannot substitute its own pool.
  const { data: poolFile } = await github.rest.repos.getContent({
    owner, repo, path: poolPath,
  });
  const pool = JSON.parse(
    Buffer.from(poolFile.content, poolFile.encoding).toString('utf8'),
  ).reviewers;

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
  // It is the tie-break every writer applies, so they agree on it.
  function lowestLogin(logins) {
    return logins.reduce((lowest, a) =>
      lowest === null || a.toLowerCase() < lowest.toLowerCase() ? a : lowest, null);
  }

  // Make `login` the sole ball-in-court assignee among flow participants
  // (the pool members and the PR author), leaving any unrelated,
  // manually-added assignees untouched.
  //
  // Handlers for different events run concurrently, so two of them can
  // act on the same snapshot and each assign its own target, which
  // leaves a court that courtHolder reports as ambiguous from then on.
  // After writing, the assignees are read back, and when another flow
  // participant is assigned too, every writer keeps the same one (the
  // lowest login) and removes the rest. Whichever writer reads last sees
  // all of them, so the court ends with a single holder.
  async function setCourt(pr, login) {
    const inFlow = (a) => inPool(a) || eq(a, pr.user.login);
    const current = (pr.assignees || []).map(a => a.login);
    const toRemove = current.filter(a => inFlow(a) && !eq(a, login));
    if (toRemove.length > 0) {
      await github.rest.issues.removeAssignees({
        owner, repo, issue_number: pr.number, assignees: toRemove,
      });
    }
    if (!current.some(a => eq(a, login))) {
      await github.rest.issues.addAssignees({
        owner, repo, issue_number: pr.number, assignees: [login],
      });
    }

    const { data: written } = await github.rest.pulls.get({
      owner, repo, pull_number: pr.number,
    });
    const holders = (written.assignees || []).map(a => a.login).filter(inFlow);
    const kept = lowestLogin(holders) ?? login;
    const raced = holders.filter(a => !eq(a, kept));
    if (raced.length > 0) {
      core.info(`A concurrent run also moved the court on PR #${pr.number}, keeping ${kept}.`);
      await github.rest.issues.removeAssignees({
        owner, repo, issue_number: pr.number, assignees: raced,
      });
    }
    core.info(`Ball in court on PR #${pr.number} is now with ${kept}.`);
  }

  return { pool, eq, inPool, isBot, courtHolder, lastPoolReviewer, setCourt };
};
