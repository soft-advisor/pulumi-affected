import type { GitHubApi, GitHubEvent } from './github.ts';
export type MergeCheck = 
/** The checkout already merges into the current base, or this isn't a pull request run */
{
    kind: 'current';
}
/** GitHub's newer merge was fetched and checked out */
 | {
    kind: 'refreshed';
    sha: string;
}
/** No newer merge came in time: the checkout merges into an older base */
 | {
    kind: 'stale';
    base: string;
};
export declare function ensureCurrentMerge(repoRoot: string, event: GitHubEvent, api: GitHubApi, token: string, sleep?: (ms: number) => Promise<unknown>): Promise<MergeCheck>;
/** Fetches a commit with the job's token, as the checkout may not have kept credentials */
export declare function fetchCommit(repoRoot: string, sha: string, token: string): boolean;
