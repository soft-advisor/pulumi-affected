import ts from 'typescript';
import { type Snapshot } from '../snapshot.ts';
export type Resolution = {
    kind: 'file';
    path: string;
} | {
    kind: 'package';
    name: string;
} | {
    kind: 'builtin';
}
/** `dir` is the folder whatever couldn't be resolved most likely lives in */
 | {
    kind: 'unresolved';
    dir?: string;
};
export declare class Resolver {
    readonly options: ts.CompilerOptions;
    /** The tsconfig.json used, if any */
    readonly tsconfig: string | undefined;
    /** npm packages the tsconfig extends; their versions count like any other package */
    readonly configPackages: string[];
    private readonly host;
    private readonly workspacePackages;
    private readonly cache;
    private readonly snapshot;
    constructor(snapshot: Snapshot, programDir: string, tsconfigPath?: string);
    /** node_modules/<workspace package>/x → the package's own folder/x */
    private throughWorkspaceLinks;
    private readCompilerOptions;
    /** Resolves `specifier` as imported from the repo-relative file `from` */
    resolve(specifier: string, from: string): Resolution;
    private resolveUncached;
    /** `#alias` specifiers, through the `imports` field of the nearest package.json */
    private resolveSubpathImport;
    private resolveWithTypeScript;
    private sourceForDeclaration;
    /**
     * A workspace package's entry usually points at build output that isn't committed, so this
     * looks for the source: through `exports` (with subpaths), the manifest's entries mapped from
     * its tsconfig's outDir to rootDir or from dist/ to src/, then src/index.
     */
    private resolveWorkspaceEntry;
    /** The source for a path in the tsconfig's outDir: the same path in its rootDir */
    sourceForOutput(path: string): string | undefined;
    /** Finds the source file for a path that may name build output or omit the extension */
    findSource(candidate: string): string | undefined;
    private existingAncestor;
}
export declare function packageName(specifier: string): string;
/** Finds `fileName` in `dir` or the nearest folder above it */
export declare function findUp(snapshot: Snapshot, dir: string, fileName: string): string | undefined;
/**
 * Workspace packages by name, mapped to their folders; built once per snapshot. Only packages
 * a workspace declares count (package.json `workspaces`, or pnpm-workspace.yaml `packages`):
 * a package.json elsewhere (a fixture, a vendored copy) doesn't stand in for the npm package of
 * the same name. The first of two with the same name wins.
 */
export declare function workspacePackagesOf(snapshot: Snapshot): Map<string, string>;
export declare function parseJson(text: string | undefined): Record<string, unknown> | undefined;
/** True when `path` is a file the program's own code could be in */
export declare function isSourcePath(path: string): boolean;
