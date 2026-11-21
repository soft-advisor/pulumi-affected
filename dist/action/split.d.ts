export declare const COMMENT_LIMIT = 60000;
/**
 * Splits a report into comment bodies under the limit, at stack boundaries. Each body starts
 * with `marker(index)` so later runs can find and update it.
 */
export declare function splitComments(heading: string, intro: string, sections: string[], marker: (index: number) => string, limit?: number): string[];
/** Text in a code block, with a fence longer than any backtick run inside it */
export declare function fence(text: string): string;
