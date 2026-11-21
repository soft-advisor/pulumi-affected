import type { GitHubEvent } from './github.ts';
export interface Context {
    base: string | undefined;
    messages: string[];
    /** Select every stack: a new branch, with nothing to compare to */
    all: boolean;
    warnings: string[];
}
export declare class EventError extends Error {
}
export declare function eventContext(event: GitHubEvent, repoRoot: string): Context;
