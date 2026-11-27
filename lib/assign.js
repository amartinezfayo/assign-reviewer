// Handles the pull_request_target and issue_comment events of the
// ball-in-court flow. See the README for the rules.

const loadCourt = require('./court.js');

// `random` is injectable so tests can make the initial pick predictable.
module.exports = async function ({ github, context, core, random = Math.random }) {
  const court = await loadCourt({ github, context, core });
  const { owner, repo } = context.repo;
  const action = context.payload.action;

  // issue_comment fires for plain issues too. Only PR comments take part
  // in the ball-in-court flow.
  if (context.eventName === 'issue_comment' &&
      !context.payload.issue.pull_request) {
    core.info(`Comment on #${context.payload.issue.number} is not on a pull request, skipping.`);
    return;
  }

  // The pull_request payload snapshot can be stale during event bursts
  // and issue_comment carries no pull_request payload at all, so always
  // act on a fresh fetch.
  const prNumber = context.payload.pull_request
    ? context.payload.pull_request.number
    : context.payload.issue.number;
  const { data: pr } = await github.rest.pulls.get({
    owner, repo, pull_number: prNumber,
  });
  const author = pr.user.login;

  // Bot-authored PRs (for example Dependabot) do not take part in the
  // rotation.
  if (court.isBot(pr.user)) {
    core.info(`PR #${pr.number} authored by bot ${author}, skipping.`);
    return;
  }
  // Comments can arrive on closed PRs.
  if (pr.state !== 'open') {
    core.info(`PR #${pr.number} is ${pr.state}, leaving court unchanged.`);
    return;
  }
  // The rotation starts when a PR leaves draft (ready_for_review), so
  // pushes and discussion on a draft move no assignee.
  if (pr.draft) {
    core.info(`PR #${pr.number} is a draft, skipping.`);
    return;
  }

  const holder = court.courtHolder(pr);
  const authorHoldsBall = holder !== null && court.eq(holder, author);

  // A new PR, or a draft promoted to ready, gets a random pool member.
  if (action === 'opened' || action === 'ready_for_review') {
    // Exclude the author so a maintainer who opens a PR is not made the
    // assignee of their own PR.
    const candidates = court.pool.filter(u => !court.eq(u, author));
    if (candidates.length === 0) {
      core.info('No eligible maintainers after excluding the author, skipping.');
      return;
    }
    const reviewer = candidates[Math.floor(random() * candidates.length)];
    core.info(`Selected assignee for PR #${pr.number} is ${reviewer}.`);
    await court.setCourt(pr, reviewer);
    return;
  }

  // A review was (re-)requested. Move the ball to that maintainer, but
  // only when the ball is currently in the author's court (the author is
  // the assignee). This keeps the CODEOWNERS auto-request that fires on
  // open from overriding the rotated assignee.
  if (action === 'review_requested') {
    const reviewer = context.payload.requested_reviewer;
    if (!reviewer || reviewer.type === 'Bot' || !court.inPool(reviewer.login)) {
      core.info('Review request is not for a pool member, skipping.');
      return;
    }
    if (!authorHoldsBall) {
      core.info(`Ball is not in the author's court on PR #${pr.number}, not overriding the rotation.`);
      return;
    }
    await court.setCourt(pr, reviewer.login);
    return;
  }

  // The author pushed commits. A push while the author holds the ball
  // hands it back to the pool member who reviewed most recently. If the
  // reviewer looks too early the cost is one glance, while a missed
  // hand-back stalls the PR.
  if (action === 'synchronize') {
    if (!authorHoldsBall) {
      core.info(`Ball is not in the author's court on PR #${pr.number}, nothing to flip.`);
      return;
    }
    const reviewer = await court.lastPoolReviewer(pr);
    if (reviewer === null) {
      core.info(`No pool member has reviewed PR #${pr.number} yet, leaving court unchanged.`);
      return;
    }
    await court.setCourt(pr, reviewer);
    return;
  }

  // A conversation comment. The ball moves to the counterpart of whoever
  // spoke, but only when the speaker holds it, so streams of comments
  // from one side produce a single flip.
  if (context.eventName === 'issue_comment') {
    const commenter = context.payload.comment.user;
    if (court.isBot(commenter)) {
      core.info('Comment by a bot, leaving court unchanged.');
      return;
    }
    if (holder === null || !court.eq(holder, commenter.login)) {
      core.info(`Commenter does not hold the ball on PR #${pr.number}, leaving court unchanged.`);
      return;
    }
    if (court.eq(commenter.login, author)) {
      const reviewer = await court.lastPoolReviewer(pr);
      if (reviewer === null) {
        core.info(`No pool member has reviewed PR #${pr.number} yet, leaving court unchanged.`);
        return;
      }
      await court.setCourt(pr, reviewer);
      return;
    }
    // The holder is either the author or a pool member, so this is a
    // pool member speaking while holding the ball. Their comment (an
    // answer, a request) puts the author on point to respond.
    await court.setCourt(pr, author);
  }
};
