import { renderMarkdown } from '../render.ts';
import { type Request, select } from '../select.ts';
import { git, repoRootOf } from '../snapshot.ts';
import { splitPatterns } from '../patterns.ts';
import {
  appendSummary,
  booleanInput,
  GitHubApi,
  type GitHubEvent,
  input,
  notice,
  readEvent,
  setOutput,
  warning,
} from './github.ts';

/*
 * The `select` action: works out the comparison base from the triggering event, collects
 * Pulumi-Affected-Run/Skip lines and /pulumi-affected commands, runs the selection and writes
 * the outputs and job summary.
 */

/** `/pulumi-affected preview <patterns>` at the start of a line in a pull request comment */
const COMMAND = /^\/pulumi-affected\s+preview\b(.*)$/gim;

/** Repository roles allowed to run commands: the ones that can push anyway */
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

const ZERO_SHA = /^0+$/;

interface PullRequest {
  number: number;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
}

interface Comment {
  id: number;
  body?: string;
  user: { login: string } | null;
}

interface Context {
  base: string | undefined;
  messages: string[];
  requests: Request[];
  all: boolean;
  pullRequest: PullRequest | undefined;
}

async function main() {
  const cwd = input('working-directory') || process.cwd();
  const repoRoot = repoRootOf(cwd);
  const event = readEvent();
  const token = input('github-token');
  const api = token ? new GitHubApi(token) : undefined;

  const context = await eventContext(event, repoRoot, api);
  if (context === undefined) {
    notice('Not a /pulumi-affected command; nothing to select');
    writeOutputs([], [], '{}');
    return;
  }

  const result = select({
    cwd,
    base: input('base') || context.base || 'HEAD',
    head: input('head') || undefined,
    bases: input('bases') ? JSON.parse(input('bases')) : undefined,
    run: splitPatterns(input('run')),
    requests: context.requests,
    skip: splitPatterns(input('skip')),
    all: booleanInput('all') || context.all,
    messages: context.messages,
  });

  for (const message of result.warnings) warning(message);
  appendSummary(renderMarkdown(result));
  writeOutputs(result.stacks, result.waves, JSON.stringify(result));
  console.log(
    result.stacks.length === 0
      ? 'No stacks affected'
      : `Selected ${result.stacks.map((stack) => stack.id).join(', ')}`,
  );
}

function writeOutputs(stacks: unknown[], waves: string[][], result: string) {
  setOutput('stacks', JSON.stringify(stacks));
  setOutput('ids', JSON.stringify(waves.flat()));
  setOutput('waves', JSON.stringify(waves));
  setOutput('any', stacks.length > 0 ? 'true' : 'false');
  setOutput('result', result);
}

/** The base revision and extra requests implied by the event; undefined means do nothing */
async function eventContext(
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
    };
  }

  if (event.name === 'push') {
    const before = String(payload.before ?? '');
    // A new branch has no previous commit to compare with
    if (!before || ZERO_SHA.test(before)) {
      return { base: undefined, messages: [], requests: [], all: true, pullRequest: undefined };
    }
    // Stacks forced in a merged pull request (description lines and commands) still apply
    const messages: string[] = [];
    const requests: Request[] = [];
    if (api) {
      for (const pullRequest of await mergedPullRequests(api, repoRoot, before)) {
        messages.push(pullRequest.body ?? '');
        requests.push(...(await commandRequests(api, pullRequest.number)));
      }
    }
    return { base: before, messages, requests, all: false, pullRequest: undefined };
  }

  return { base: undefined, messages: [], requests: [], all: false, pullRequest: undefined };
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

main().catch((error: unknown) => {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
