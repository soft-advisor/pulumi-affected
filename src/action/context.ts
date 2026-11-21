import type { Request } from '../select.ts';
import { ensureCommit, git, isSha } from '../snapshot.ts';
import { splitPatterns } from '../patterns.ts';
import type { GitHubApi, GitHubEvent } from './github.ts';

/*
 * What the triggering event means for selection: the revision to compare with, and stacks
 * requested by pull request descriptions and /pulumi-affected comments.
 *
 * Commands run code with whatever credentials the job holds, so they only ever come from people
 * with write access, and pull requests from forks never run through a comment.
 */

/** `/pulumi-affected preview <patterns>` at the start of a line in a pull request comment */
const COMMAND = /^\/pulumi-affected\s+preview\b(.*)$/im;
const COMMANDS = new RegExp(COMMAND.source, 'gim');

/** Base permissions that can run commands: the ones that can push anyway */
const WRITE_PERMISSIONS = new Set(['admin', 'write']);

const ZERO_SHA = /^0+$/;

/** Comments the action wrote itself start with a marker; they never count as commands */
const OWN_COMMENT = /^<!-- pulumi-affected:/;

export interface PullRequest {
  number: number;
  body: string | null;
  base: { sha: string; ref?: string; repo?: { full_name: string } | null };
  head: { sha: string; repo?: { full_name: string } | null };
  merged_at?: string | null;
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
  warnings: string[];
}

const EMPTY: Context = {
  base: undefined,
  messages: [],
  requests: [],
  all: false,
  pullRequest: undefined,
  mergedPullRequests: [],
  warnings: [],
};

export class EventError extends Error {}

/** The base revision and extra requests implied by the event; undefined means do nothing */
export async function eventContext(
  event: GitHubEvent,
  repoRoot: string,
  api: GitHubApi | undefined,
): Promise<Context | undefined> {
  const payload = event.payload as Record<string, unknown>;

  if (event.name === 'pull_request' || event.name === 'pull_request_target') {
    const pullRequest = payload.pull_request as PullRequest;
    // pull_request_target runs with the base repository's secrets; running a fork's code there
    // is the classic way to hand them over
    if (
      event.name === 'pull_request_target' &&
      isFork(pullRequest) &&
      headIs(repoRoot, pullRequest)
    ) {
      throw new EventError(
        "pull_request_target with a fork's code checked out would run it with this repository's secrets; use pull_request",
      );
    }
    const warnings: string[] = [];
    return {
      ...EMPTY,
      base: mergeBase(repoRoot, pullRequest.base.sha),
      messages: [pullRequest.body ?? ''],
      requests: api ? await commandRequests(api, pullRequest.number, warnings) : [],
      pullRequest,
      warnings,
    };
  }

  if (event.name === 'issue_comment') {
    const issue = payload.issue as { number: number; pull_request?: unknown };
    const comment = payload.comment as Comment;
    // Edited and deleted comments trigger workflows too; only a new comment is a command
    if (payload.action !== 'created' || !issue.pull_request || !COMMAND.test(comment.body ?? '')) {
      return undefined;
    }
    if (!api) throw new EventError('issue_comment events need the github-token input');
    const login = comment.user?.login ?? '';
    if (!(await canWrite(api, login))) {
      return undefined; // commandRequests replies to it when the pull request next runs
    }
    const pullRequest = await api.request<PullRequest>('GET', api.repo(`/pulls/${issue.number}`));
    if (isFork(pullRequest)) {
      throw new EventError(
        "Commands don't run on pull requests from forks: their code would run with this workflow's credentials",
      );
    }
    if (!headIs(repoRoot, pullRequest)) {
      const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
      throw new EventError(
        `The checkout is at ${head}, not the pull request's head ${pullRequest.head.sha}. ` +
          'Check out refs/pull/<number>/head before this action on issue_comment events.',
      );
    }
    const warnings: string[] = [];
    return {
      ...EMPTY,
      base: mergeBase(repoRoot, pullRequest.base.sha),
      messages: [pullRequest.body ?? ''],
      requests: await commandRequests(api, pullRequest.number, warnings),
      pullRequest,
      warnings,
    };
  }

  if (event.name === 'merge_group') {
    // A merge queue's group is compared with the branch it merges into
    const group = payload.merge_group as { base_sha: string };
    return { ...EMPTY, base: mergeBase(repoRoot, group.base_sha) };
  }

  if (event.name === 'push') {
    const before = String(payload.before ?? '');
    // A new branch has no previous commit to compare with
    if (!before || ZERO_SHA.test(before)) return { ...EMPTY, all: true };
    const warnings: string[] = [];
    if (!ensureCommit(repoRoot, before)) {
      // A force push: the previous commit is gone. Deploys still compare each stack with its
      // last deploy; anything else has nothing to compare with.
      warnings.push(`The push's previous commit ${before} isn't available (a force push?)`);
      return { ...EMPTY, warnings };
    }
    const branch = String(payload.ref ?? '').replace(/^refs\/heads\//, '');
    // Stacks forced in a merged pull request (description lines and commands) still apply
    const merged = api ? await mergedPullRequests(api, repoRoot, before, branch) : [];
    const messages: string[] = [];
    const requests: Request[] = [];
    for (const pullRequest of merged) {
      messages.push(pullRequest.body ?? '');
      if (api) requests.push(...(await commandRequests(api, pullRequest.number, warnings)));
    }
    return { ...EMPTY, base: before, messages, requests, mergedPullRequests: merged, warnings };
  }

  return { ...EMPTY };
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
  const pullRequest = await api.request<PullRequest>('GET', api.repo(`/pulls/${number}`));
  const warnings: string[] = [];
  const messages = [pullRequest.body ?? ''];
  const requests = await commandRequests(api, number, warnings);
  if (pullRequest.merged_at) {
    return { ...EMPTY, messages, requests, mergedPullRequests: [pullRequest], warnings };
  }
  return {
    ...EMPTY,
    base: mergeBase(repoRoot, pullRequest.base.sha),
    messages,
    requests,
    pullRequest,
    warnings,
  };
}

function isFork(pullRequest: PullRequest) {
  const head = pullRequest.head.repo?.full_name;
  const base = pullRequest.base.repo?.full_name;
  // A deleted fork has no repository; treat it as a fork
  return !head || !base || head !== base;
}

function headIs(repoRoot: string, pullRequest: PullRequest) {
  return git(repoRoot, ['rev-parse', 'HEAD']).trim() === pullRequest.head.sha;
}

function mergeBase(repoRoot: string, baseSha: string) {
  if (!isSha(baseSha)) throw new EventError(`Not a commit SHA: ${baseSha}`);
  try {
    return git(repoRoot, ['merge-base', baseSha, 'HEAD']).trim();
  } catch {
    throw new EventError(
      `Can't find the merge base with ${baseSha}. Check out with fetch-depth: 0 so history is available.`,
    );
  }
}

/**
 * Stack patterns from /pulumi-affected commands on a pull request. Commands count only from
 * people with write access; others get one reply explaining why theirs was ignored.
 */
async function commandRequests(api: GitHubApi, number: number, warnings: string[]) {
  const comments = await api.list<Comment>(api.repo(`/issues/${number}/comments`));
  const access = new Map<string, boolean>();
  const requests: Request[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (OWN_COMMENT.test(body)) continue;
    const lines = [...body.matchAll(COMMANDS)].map((match) => match[1]);
    const login = comment.user?.login;
    if (lines.length === 0 || !login) continue;

    let allowed = access.get(login);
    if (allowed === undefined) {
      allowed = await canWrite(api, login);
      access.set(login, allowed);
    }
    if (!allowed) {
      await replyIgnored(api, number, comment, comments, warnings);
      continue;
    }
    const source = `/pulumi-affected preview from @${login} on #${number}`;
    for (const line of lines) {
      for (const pattern of splitPatterns(line)) requests.push({ pattern, source });
    }
  }
  return requests;
}

/**
 * Whether the user can push to the repository. The base `permission` is used rather than the
 * role name, so custom roles built on write count; GitHub answers 404 for non-collaborators.
 */
async function canWrite(api: GitHubApi, login: string) {
  if (!login) return false;
  try {
    const result = await api.request<{ permission: string }>(
      'GET',
      api.repo(`/collaborators/${encodeURIComponent(login)}/permission`),
    );
    return WRITE_PERMISSIONS.has(result.permission);
  } catch {
    return false;
  }
}

async function replyIgnored(
  api: GitHubApi,
  number: number,
  comment: Comment,
  comments: Comment[],
  warnings: string[],
) {
  const marker = `<!-- pulumi-affected:ignored:${comment.id} -->`;
  const self = await api.identity();
  const replied = comments.some(
    (existing) => existing.user?.login === self && existing.body?.startsWith(marker),
  );
  if (replied) return;
  try {
    await api.request('POST', api.repo(`/issues/${number}/comments`), {
      body: `${marker}\n@${comment.user?.login} only people with write access to this repository can run \`/pulumi-affected\` commands, so this one was ignored.`,
    });
  } catch (error) {
    // Pull requests from forks get a read-only token
    warnings.push(
      `Couldn't reply to an ignored command: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Pull requests merged into `branch` by a push. Following first parents visits each merge once
 * instead of every commit of every merged branch.
 */
async function mergedPullRequests(
  api: GitHubApi,
  repoRoot: string,
  before: string,
  branch: string,
) {
  const commits = git(repoRoot, ['rev-list', '--first-parent', `${before}..HEAD`])
    .split('\n')
    .filter(Boolean);
  const pullRequests = new Map<number, PullRequest>();
  for (const sha of commits) {
    const found = await api.request<PullRequest[]>('GET', api.repo(`/commits/${sha}/pulls`));
    for (const pullRequest of found) {
      // The endpoint also returns open pull requests containing the commit
      if (pullRequest.merged_at && (!branch || pullRequest.base.ref === branch)) {
        pullRequests.set(pullRequest.number, pullRequest);
      }
    }
  }
  return [...pullRequests.values()];
}
