import { git } from '../snapshot.ts';
import type { GitHubApi, GitHubEvent } from './github.ts';

/*
 * A pull request run checks out GitHub's merge of the pull request into its base. GitHub
 * computes that merge in the background, so right after the base changes (a retarget, or the
 * base branch moving) the run can get one made with the old base. This waits for GitHub's new
 * merge and checks it out, so the preview is of the code that would be merged. GitHub gives no
 * duration for this; it reports `mergeable: null` while it's still working.
 */

const POLL_MS = 5_000;
const WAIT_MS = 120_000;

export type MergeCheck =
  /** The checkout already merges into the current base, or this isn't a pull request run */
  | { kind: 'current' }
  /** GitHub's newer merge was fetched and checked out */
  | { kind: 'refreshed'; sha: string }
  /** No newer merge came in time: the checkout merges into an older base */
  | { kind: 'stale'; base: string };

interface PullRequest {
  number: number;
  mergeable: boolean | null;
  merge_commit_sha: string | null;
  base: { sha: string };
}

export async function ensureCurrentMerge(
  repoRoot: string,
  event: GitHubEvent,
  api: GitHubApi,
  token: string,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<MergeCheck> {
  if (event.name !== 'pull_request') return { kind: 'current' };
  const pull = event.payload.pull_request as
    | { number?: number; base?: { sha?: string } }
    | undefined;
  const base = pull?.base?.sha;
  if (!pull?.number || !base) return { kind: 'current' };
  // A shallow checkout can't tell; the preview needs history anyway (fetch-depth: 0)
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^1']);
  } catch {
    return { kind: 'current' };
  }
  fetchCommit(repoRoot, base, token);
  if (mergesInto(repoRoot, 'HEAD', base)) return { kind: 'current' };

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const current = await api.request<PullRequest>('GET', api.repo(`/pulls/${pull.number}`));
    const sha = current.merge_commit_sha;
    if (current.mergeable !== null && sha && fetchCommit(repoRoot, sha, token)) {
      if (mergesInto(repoRoot, sha, current.base.sha)) {
        git(repoRoot, ['checkout', '--quiet', '--detach', sha]);
        return { kind: 'refreshed', sha };
      }
    }
    if (Date.now() + POLL_MS > deadline) return { kind: 'stale', base };
    await sleep(POLL_MS);
  }
}

/** Whether a merge commit's first parent is (or includes) the base commit */
function mergesInto(repoRoot: string, commit: string, base: string) {
  try {
    const parent = git(repoRoot, ['rev-parse', `${commit}^1`]).trim();
    git(repoRoot, ['merge-base', '--is-ancestor', base, parent]);
    return true;
  } catch {
    return false;
  }
}

/** Fetches a commit with the job's token, as the checkout may not have kept credentials */
function fetchCommit(repoRoot: string, sha: string, token: string) {
  try {
    git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    // Not here yet
  }
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  try {
    git(repoRoot, [
      '-c',
      `http.${server}/.extraheader=AUTHORIZATION: basic ${basic}`,
      'fetch',
      '--quiet',
      '--no-tags',
      `${server}/${repository}`,
      sha,
    ]);
    return true;
  } catch {
    return false;
  }
}
