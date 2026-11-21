import type { Author, GitHubApi } from './github.ts';
export interface Comment {
    id: number;
    body?: string;
    user: Author | null;
}
export declare function marker(kind: string, index: number): string;
/**
 * Makes the pull request's `kind` comments match `bodies`, editing existing ones in place.
 * With `onlyIfPresent`, nothing is posted when there's no earlier comment to update.
 */
export declare function syncComments(api: GitHubApi, number: number, kind: string, bodies: string[], onlyIfPresent?: boolean): Promise<void>;
