/**
 * The repository's files at one point in time: a commit, or the working tree. Paths are
 * repo-relative and use forward slashes. Hashes are git blob ids, so the same content has the
 * same hash in every snapshot and unchanged files can be skipped cheaply.
 *
 * Symbolic links are followed while they stay inside the repository, for files and folders
 * alike; one that points outside reads as its target path, as git stores it, so nothing outside
 * the repository is ever read. Submodules appear as entries whose hash is their commit.
 */
export interface Snapshot {
    /** A commit SHA, or "working tree" */
    readonly label: string;
    /** Every file, link and submodule, by its own path */
    readonly paths: readonly string[];
    has(path: string): boolean;
    isDirectory(path: string): boolean;
    read(path: string): string | undefined;
    hash(path: string): string | undefined;
    /** The path with links resolved, or undefined when it leaves the repository */
    realPath(path: string): string | undefined;
}
export declare function git(repoRoot: string, args: string[], input?: string): string;
export declare function repoRootOf(cwd: string): string;
export declare function resolveCommit(repoRoot: string, rev: string): string;
type Entry = {
    kind: 'file';
    id?: string;
} | {
    kind: 'link';
    id: string;
    target: string;
}
/** A submodule; its id is the commit it's at */
 | {
    kind: 'submodule';
    id: string;
};
declare abstract class BaseSnapshot implements Snapshot {
    abstract readonly label: string;
    protected abstract readonly entries: Map<string, Entry>;
    protected abstract readFile(path: string, entry: Entry): string;
    protected abstract idOf(path: string, entry: Entry): string;
    private directories;
    get paths(): readonly string[];
    realPath(path: string): string | undefined;
    has(path: string): boolean;
    hash(path: string): string | undefined;
    read(path: string): string | undefined;
    isDirectory(path: string): boolean;
}
/** Files committed at a revision, read from git's object store */
export declare class GitSnapshot extends BaseSnapshot {
    readonly label: string;
    protected readonly entries: Map<string, Entry>;
    private readonly repoRoot;
    private prefetched;
    constructor(repoRoot: string, commit: string);
    protected idOf(_path: string, entry: Entry): string;
    protected readFile(_path: string, entry: Entry): string;
}
/** Files in the working tree that git tracks or would track, including uncommitted changes */
export declare class WorktreeSnapshot extends BaseSnapshot {
    readonly label = "working tree";
    protected readonly entries: Map<string, Entry>;
    private readonly repoRoot;
    constructor(repoRoot: string);
    protected idOf(path: string, entry: Entry): string;
    protected readFile(path: string): string;
}
export declare function trimSlashes(path: string): string;
/** Joins repo-relative path segments, resolving "." and "..", where "" is the repo root */
export declare function joinPath(...segments: string[]): string;
export declare function dirnameOf(path: string): string;
/** True when `path` is `dir` itself or inside it; "" is the repo root */
export declare function isInside(path: string, dir: string): boolean;
export declare function isSha(value: string): boolean;
/** True when the commit is available locally, fetching it if needed */
export declare function ensureCommit(repoRoot: string, sha: string): boolean;
export {};
