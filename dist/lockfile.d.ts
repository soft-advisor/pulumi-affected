import { type Snapshot } from './snapshot.ts';
export interface LockNode {
    name: string;
    version: string;
    /**
     * Everything that pins what gets installed: the version, plus where it comes from and its
     * checksum, so a git dependency moving to another commit or a changed patch counts too
     */
    identity: string;
    dependencies: string[];
}
export interface LockGraph {
    /** Repo-relative path of the lockfile */
    path: string;
    /** Repo-relative workspace folder → dependency name → node id */
    importers: Map<string, Map<string, string>>;
    nodes: Map<string, LockNode>;
}
export declare class LockfileError extends Error {
}
/**
 * Finds the lockfile serving `dir`: the nearest folder in or above it with one. When a folder
 * has several (a leftover yarn.lock next to package-lock.json), `packageManager` in its
 * package.json decides; without it, the choice is reported.
 */
export declare function findLockfile(snapshot: Snapshot, dir: string, warnings?: string[]): string | undefined;
export declare function readLockfile(snapshot: Snapshot, path: string): LockGraph;
/** True when the lockfile resolves a package of this name anywhere, under its name or an alias */
export declare function hasPackage(graph: LockGraph, name: string): boolean;
/** The package versions reachable from `names` as loaded by code in `fromFile` */
export declare function packageClosure(graph: LockGraph, fromFiles: Map<string, Set<string>>): Set<string>;
