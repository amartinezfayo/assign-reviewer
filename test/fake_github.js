// A small in-memory stand-in for the github-script `github`, `context`
// and `core` objects. Assignee calls mutate the stored pull request so
// tests assert on the resulting state.

// `poolFile` replaces the pool file's text, for malformed-file tests, and
// `unassignable` lists logins that addAssignees drops the way the API
// drops a login it cannot assign.
function fakeGithub({ pool, prs, reviews = {}, events = {}, comments = {}, poolFile, unassignable = [] }) {
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const find = (number) => {
    const pr = byNumber.get(number);
    if (!pr) {
      throw new Error(`pull request ${number} not found`);
    }
    return pr;
  };
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

  const rest = {
    repos: {
      getContent: async ({ path }) => {
        if (path !== '.github/reviewer-pool.json') {
          throw new Error(`unexpected path ${path}`);
        }
        const content = Buffer.from(poolFile ?? JSON.stringify({ reviewers: pool })).toString('base64');
        return { data: { content, encoding: 'base64' } };
      },
    },
    pulls: {
      get: async ({ pull_number }) => ({ data: find(pull_number) }),
      list: async () => ({ data: prs }),
      listReviews: async ({ pull_number }) => ({ data: reviews[pull_number] || [] }),
    },
    issues: {
      addAssignees: async ({ issue_number, assignees }) => {
        const pr = find(issue_number);
        // Like the API, adding a login that is already assigned is a no-op.
        const added = assignees.filter(login =>
          !pr.assignees.some(a => eq(a.login, login)) &&
          !unassignable.some(u => eq(u, login)));
        pr.assignees = [...pr.assignees, ...added.map(login => ({ login }))];
      },
      removeAssignees: async ({ issue_number, assignees }) => {
        const pr = find(issue_number);
        pr.assignees = pr.assignees.filter(a => !assignees.some(r => eq(r, a.login)));
      },
      listEvents: async ({ issue_number }) => ({ data: events[issue_number] || [] }),
      listComments: async ({ issue_number }) => ({ data: comments[issue_number] || [] }),
    },
  };

  const paginate = async (method, params) => (await method(params)).data;
  paginate.iterator = async function* (method, params) {
    yield await method(params);
  };

  return { rest, paginate };
}

function fakeCore() {
  const core = {
    failures: [],
    infos: [],
    warnings: [],
    info: (message) => core.infos.push(message),
    warning: (message) => core.warnings.push(message),
    setFailed: (message) => core.failures.push(message),
  };
  return core;
}

function pullRequest({ number = 1, author = 'contributor', assignees = [], ...rest }) {
  return {
    number,
    user: { login: author, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: 'head-sha' },
    assignees: assignees.map(login => ({ login })),
    requested_reviewers: [],
    ...rest,
  };
}

const assigneesOf = (pr) => pr.assignees.map(a => a.login);

const repo = { owner: 'spiffe', repo: 'example' };

module.exports = { fakeGithub, fakeCore, pullRequest, assigneesOf, repo };
