import type { Author, GitHubApi } from './github.ts';
export interface Comment {
    id: number;
    node_id?: string;
    body?: string;
    user: Author | null;
}
export declare function marker(kind: string, index: number): string;
/**
 * Makes the pull request's `kind` comments match `bodies`, editing existing ones in place.
 * With `onlyIfPresent`, nothing is posted when there's no earlier comment to update.
 */
export declare function syncComments(api: GitHubApi, number: number, kind: string, bodies: string[], onlyIfPresent?: boolean): Promise<void>;
/** What a report was made from, shown in it: e.g. "Previewed" at the pull request's head */
export interface ReportStatus {
    verb: string;
    sha: string;
    url: string;
}
/**
 * Posts a report that's read when it changes. When the results differ from the last report, the
 * old comments are hidden as outdated and the new ones posted, so GitHub notifies; when they're
 * the same, the existing comments are only updated to say so, which notifies no one.
 */
export declare function postReport(api: GitHubApi, number: number, kind: string, bodies: string[], status: ReportStatus): Promise<void>;
