/** An input, as the runtime passes it, or as a composite action's step passes it (`-` as `_`) */
export declare function input(name: string): string;
export declare function booleanInput(name: string): boolean;
export declare function setOutput(name: string, value: string): void;
export declare function appendSummary(markdown: string): void;
/**
 * Prints text from outside the action (Pulumi's output, names from the repository) so that no
 * line of it can be read as a workflow command such as ::set-env or ::stop-commands.
 */
export declare function printUntrusted(text: string): void;
export declare function error(message: string): void;
export declare function warning(message: string): void;
export declare function notice(message: string): void;
export interface GitHubEvent {
    name: string;
    payload: Record<string, unknown>;
}
export declare function readEvent(): GitHubEvent;
export interface Author {
    login: string;
    type?: string;
}
export declare class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare class GitHubApi {
    private readonly token;
    private readonly baseUrl;
    readonly repository: string;
    constructor(token: string, repository?: string);
    /**
     * Calls the API, retrying server errors and rate limits a few times with backoff, since one
     * transient failure shouldn't fail a deploy
     */
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
    /** Runs a GraphQL query or mutation */
    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
    /** Every page of a list endpoint */
    list<T>(path: string): Promise<T[]>;
    private ownership;
    /**
     * How to tell the action's own comments: by the login behind a personal token, or, for the
     * workflow's token (which can't read /user), by being github-actions[bot]. Other bots' comments
     * are never edited, even with the marker; a GitHub App token posts new comments each run.
     */
    ownComments(): Promise<(author: Author | null) => boolean>;
    repo(path: string): string;
}
