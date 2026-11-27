# assign-reviewer

Shared GitHub Actions that keep a single "ball in court" assignee on every
pull request, for SPIFFE projects that opt in.

The actions do not request reviewers. They designate one maintainer from a
per-repository pool as the pull request assignee, to show who owns the next
action, and keep that assignee up to date as the review progresses.

## How the ball moves

| Event | Condition | New assignee |
|---|---|---|
| Pull request opened or marked ready | Always | A random pool member other than the author |
| Review re-requested from a pool member | The author holds the ball | The requested pool member |
| Commits are pushed, by the author or anybody else | The author holds the ball | The pool member who reviewed most recently |
| Author comments or replies on review threads | The author holds the ball | The pool member who reviewed most recently |
| Pool member comments in the conversation | That pool member holds the ball | The author |
| Pool member requests changes or submits a comment review | Always | The author |
| Pool member approves | Always | That pool member, who is expected to merge |

Activity-driven moves only happen when the acting user currently holds the
ball. Repeated pushes or comments by the same person are therefore no-ops,
and a manual assignee change is never overridden. Draft pull requests and
pull requests opened by bots are left alone. Assignees who are neither the
author nor in the pool are never touched.

## Actions

| Action | Calling event | Token | Purpose |
|---|---|---|---|
| `assign` | `pull_request_target`, `issue_comment` | write | Initial pick and the moves driven by pushes, review requests and comments |
| `capture` | `pull_request_review` | read | Records the submitted review in an artifact |
| `apply` | `workflow_run` on the capture workflow | write | Moves the assignee for the recorded review |
| `reconcile` | `schedule`, `workflow_dispatch` | write | Reapplies review moves that GitHub dropped |

Review handling is split in two because `pull_request_review` provides a
read-only token on pull requests from forks. The capture half runs there
and only uploads an artifact. The apply half runs from the default branch
through `workflow_run`, where the token can write.

GitHub does not always run the capture half. The run waits for approval on
a first-time contributor's pull request, is not created while the pull
request has a merge conflict, and can fail or be cancelled. The reconcile
action looks at recently reviewed pull requests and reapplies the move of
the latest review when it was lost. It stands down when a push, a pending
review request or any later assignee change shows that somebody already
decided the court.

## Opting in

A repository opts in by adding five files to its default branch.

1. `.github/reviewer-pool.json` with the maintainers who take part in the
   rotation.

   ```json
   {
     "reviewers": ["octocat", "hubot"]
   }
   ```

2. Four workflows, one per action. Copy them from `examples/` and replace
   the pinned commit and the repository name in the reconcile guard.

The workflows only take effect once they are on the default branch, because
`pull_request_target`, `issue_comment`, `workflow_run` and `schedule` all
run the default branch's copy. A pull request that adds them does not
exercise them.

Two details have to stay in sync inside each repository. The apply workflow
names the capture workflow in its `workflow_run` filter, so that filter and
the capture workflow's `name` must match. The reconcile job is guarded by a
`github.repository` check so the schedule does nothing in forks.

The pool is separate from CODEOWNERS on purpose. It can be adjusted for
availability, such as leave or inactivity, without touching ownership. The
actions assume something else requests reviews, typically CODEOWNERS.

## Security model

The assign, apply and reconcile jobs hold a token that can write issues and
pull requests, and two of them are reachable from pull requests opened from
forks. These properties keep that safe, and changes to this repository must
preserve them.

- No action checks out the calling repository, so no pull request code is
  ever run. The scripts ship inside the action at the commit the caller
  pins. This repository's own workflows are the one exception described
  under Development, and they only ever check out the default branch.
- The pool is read through the API from the default branch, so a pull
  request cannot substitute its own.
- Text controlled by a pull request is never interpolated into a shell or a
  script. Inputs reach the scripts through the environment.
- The capture artifact is untrusted, since a fork can run a modified copy
  of the capture workflow. The apply action validates every field, requires
  the pull request head to equal the head of the run that produced the
  artifact, and confirms through the API that the claimed review is the
  submitter's latest one.
- The only logins ever assigned are pool members and the pull request
  author as returned by the API.

Callers should pin the actions to a full commit SHA and let Dependabot
propose updates. This repository holds code that runs with write tokens in
every repository that opts in, so its default branch should be protected
and changes reviewed by its owners.

## Development

The logic lives in `lib/` as plain Node modules that receive the
`github`, `context` and `core` objects from `actions/github-script`. Each
`action.yml` is a thin wrapper around one module. Tests use an in-memory
stand-in for the API and need no dependencies.

```sh
npm test
```

This repository runs the rotation on its own pull requests. Its workflows
in `.github/workflows` differ from the ones in `examples/` in one way. They
check out the default branch and run the actions from there with a local
path, where a repository that opts in pins a commit. That way the latest
code is exercised here first. When a change affects what a calling workflow
needs, such as triggers, permissions or inputs, update both sets.

## License

Apache License 2.0. See [LICENSE](LICENSE).
