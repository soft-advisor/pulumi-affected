import { ensureCommit, git, isSha } from '../snapshot.ts';
import type { GitHubEvent } from './github.ts';

/*
 * What the triggering event means for selection: the revision to compare with, and the text
 * (a pull request description) whose Pulumi-Affected-Run/Skip lines count. Selection only reads
 * files and never runs the repository's code, so no event needs special care here; what runs the
 * code afterwards is the workflow's business.
 */

export interface Context {
  base: string | undefined;
  messages: string[];
  /** Select every stack: a new branch, with nothing to compare to */
  all: boolean;
  warnings: string[];
}

interface PullRequest {
  body: string | null;
  base: { sha: string };
}

const ZERO_SHA = /^0+$/;

const EMPTY: Context = { base: undefined, messages: [], all: false, warnings: [] };

export class EventError extends Error {}

export function eventContext(event: GitHubEvent, repoRoot: string): Context {
  const payload = event.payload as Record<string, unknown>;

  if (event.name === 'pull_request' || event.name === 'pull_request_target') {
    const pullRequest = payload.pull_request as PullRequest;
    return {
      ...EMPTY,
      base: mergeBase(repoRoot, pullRequest.base.sha),
      messages: [pullRequest.body ?? ''],
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
    if (!ensureCommit(repoRoot, before)) {
      // A force push: the previous commit is gone
      return {
        ...EMPTY,
        warnings: [`The push's previous commit ${before} isn't available (a force push?)`],
      };
    }
    return { ...EMPTY, base: before };
  }

  return { ...EMPTY };
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
