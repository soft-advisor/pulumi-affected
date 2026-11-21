import type { Request } from '../select.ts';
import { git } from '../snapshot.ts';
import { splitPatterns } from '../patterns.ts';
import type { GitHubApi, GitHubEvent } from './github.ts';

/*
 * What the triggering event means for selection: the revision to compare with, and stacks
 * requested by pull request descriptions and /pulumi-affected comments.
 */

/** `/pulumi-affected preview <patterns>` at the start of a line in a pull request comment */
const COMMAND = /^\/pulumi-affected\s+preview\b(.*)$/gim;

/** Repository roles allowed to run commands: the ones that can push anyway */
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

const ZERO_SHA = /^0+$/;

export interface PullRequest {
  number: number;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
}

export interface Comment {
  id: number;
  body?: string;
  user: { login: string } | null;
}

export interface Context {
  base: string | undefined;
  messages: string[];
  requests: Request[];
  all: boolean;
  pullRequest: PullRequest | undefined;
  /** On a push: the pull requests it merged */
  mergedPullRequests: PullRequest[];
}

/** The base revision and extra requests implied by the event; undefined means do nothing */
export async function eventContext(
  event: GitHubEvent,
  repoRoot: string,
  api: GitHubApi | undefined,
): Promise<Context | undefined> {
  const payload = event.payload as Record<string, unknown>;

  if (event.name === 'pull_request' || event.name === 'pull_request_target') {
    const pullRequest = payload.pull_request as PullRequest;
    return {
      base: mergeBase(repoRoot, pullRequest.base.sha),
      messages: [pullRequest.body ?? ''],
      requests: api ? await commandRequests(api, pullRequest.number) : [],
      all: false,
      pullRequest,
      mergedPullRequests: [],
    };
  }

  if (event.name === 'issue_comment') {
    const issue = payload.issue as { number: number; pull_request?: unknown };
    const comment = payload.comment as Comment;
    if (!issue.pull_request || !matchesCommand(comment.body ?? '')) return undefined;
    if (!api) throw new Error('issue_comment events need the github-token input');
    const pullRequest = await api.request<PullRequest>('GET', api.repo(`/pulls/${issue.number}`));
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (head !== pullRequest.head.sha) {
      throw new Error(
        `The checkout is at ${head}, not the pull request's head ${pullRequest.head.sha}. ` +
          'Check out refs/pull/<number>/head before this action on issue_comment events.',
      );
    }
    return {
      base: mergeBase(repoRoot, pullRequest.base.sha),
      messages: [pullRequest.body ?? ''],
      requests: await commandRequests(api, pullRequest.number),
      all: false,
      pullRequest,
      mergedPullRequests: [],
    };
  }

  if (event.name === 'push') {
    const before = String(payload.before ?? '');
    // A new branch has no previous commit to compare with
    if (!before || ZERO_SHA.test(before)) {
      return {
        base: undefined,
        messages: [],
        requests: [],
        all: true,
        pullRequest: undefined,
        mergedPullRequests: [],
      };
    }
    // Stacks forced in a merged pull request (description lines and commands) still apply
    const messages: string[] = [];
    const requests: Request[] = [];
    const merged = api ? await mergedPullRequests(api, repoRoot, before) : [];
    for (const pullRequest of merged) {
      if (api) {
        messages.push(pullRequest.body ?? '');
        requests.push(...(await commandRequests(api, pullRequest.number)));
      }
    }
    return {
      base: before,
      messages,
      requests,
      all: false,
      pullRequest: undefined,
      mergedPullRequests: merged,
    };
  }

  return {
    base: undefined,
    messages: [],
    requests: [],
    all: false,
    pullRequest: undefined,
    mergedPullRequests: [],
  };
}

/**
 * The context of a pull request named explicitly (the `pull-request` input) rather than by the
 * event: an open one is previewed against its merge base, a merged one is what a deploy reports
 * on.
 */
export async function pullRequestContext(
  api: GitHubApi,
  repoRoot: string,
  number: number,
): Promise<Context> {
  const pullRequest = await api.request<PullRequest & { merged_at: string | null }>(
    'GET',
    api.repo(`/pulls/${number}`),
  );
  const messages = [pullRequest.body ?? ''];
  const requests = await commandRequests(api, number);
  if (pullRequest.merged_at) {
    return {
      base: undefined,
      messages,
      requests,
      all: false,
      pullRequest: undefined,
      mergedPullRequests: [pullRequest],
    };
  }
  return {
    base: mergeBase(repoRoot, pullRequest.base.sha),
    messages,
    requests,
    all: false,
    pullRequest,
    mergedPullRequests: [],
  };
}

function mergeBase(repoRoot: string, baseSha: string) {
  try {
    return git(repoRoot, ['merge-base', baseSha, 'HEAD']).trim();
  } catch {
    throw new Error(
      `Can't find the merge base with ${baseSha}. Check out with fetch-depth: 0 so history is available.`,
    );
  }
}

function matchesCommand(body: string) {
  COMMAND.lastIndex = 0;
  return COMMAND.test(body);
}

/**
 * Stack patterns from /pulumi-affected commands on a pull request. Commands count only from
 * people with write access; others get one reply explaining why theirs was ignored.
 */
async function commandRequests(api: GitHubApi, number: number) {
  const comments = await api.list<Comment>(api.repo(`/issues/${number}/comments`));
  const roles = new Map<string, string>();
  const requests: Request[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    const lines = [...body.matchAll(COMMAND)].map((match) => match[1]);
    const login = comment.user?.login;
    if (lines.length === 0 || !login) continue;

    let role = roles.get(login);
    if (role === undefined) {
      role = await repositoryRole(api, login);
      roles.set(login, role);
    }
    if (!WRITE_ROLES.has(role)) {
      await replyIgnored(api, number, comment, comments);
      continue;
    }
    const source = `/pulumi-affected preview from @${login} on #${number}`;
    for (const line of lines) {
      for (const pattern of splitPatterns(line)) requests.push({ pattern, source });
    }
  }
  return requests;
}

/** The user's role in the repository; GitHub answers 404 for people who aren't collaborators */
async function repositoryRole(api: GitHubApi, login: string) {
  try {
    const permission = await api.request<{ role_name?: string; permission: string }>(
      'GET',
      api.repo(`/collaborators/${encodeURIComponent(login)}/permission`),
    );
    return permission.role_name ?? permission.permission;
  } catch {
    return 'none';
  }
}

async function replyIgnored(api: GitHubApi, number: number, comment: Comment, comments: Comment[]) {
  const marker = `<!-- pulumi-affected:ignored:${comment.id} -->`;
  if (comments.some((existing) => existing.body?.includes(marker))) return;
  await api.request('POST', api.repo(`/issues/${number}/comments`), {
    body: `${marker}\n@${comment.user?.login} only people with write access to this repository can run \`/pulumi-affected\` commands, so this one was ignored.`,
  });
}

/** Pull requests merged by the commits of a push */
async function mergedPullRequests(api: GitHubApi, repoRoot: string, before: string) {
  const commits = git(repoRoot, ['rev-list', `${before}..HEAD`])
    .split('\n')
    .filter(Boolean);
  const pullRequests = new Map<number, PullRequest>();
  for (const sha of commits) {
    const found = await api.request<PullRequest[]>('GET', api.repo(`/commits/${sha}/pulls`));
    for (const pullRequest of found) pullRequests.set(pullRequest.number, pullRequest);
  }
  return [...pullRequests.values()];
}
