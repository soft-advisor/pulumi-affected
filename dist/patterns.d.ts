/** A stack as patterns see it: by project name and by project folder ("" is the repo root) */
export interface StackName {
    project: string;
    dir: string;
    stack: string;
}
export declare const ALL = "all";
/**
 * Stack patterns are "<project>/<stack>", where <project> is the project's name or folder, or a
 * bare "<stack>" for that stack in every project. Both parts may be globs. "all" and "*" match
 * every stack.
 */
export declare function matchesStack(pattern: string, name: StackName): boolean;
export declare function matchesAnyStack(patterns: readonly string[], name: StackName): boolean;
/** Matches repo-relative paths (or names) against a glob; dotfiles match like any other file */
export declare function glob(pattern: string): (value: string) => boolean;
export declare function matchesAnyGlob(patterns: readonly string[], path: string): boolean;
/** Splits a list written by hand ("dns, accounts/*" or one per line) into patterns */
export declare function splitPatterns(text: string): string[];
