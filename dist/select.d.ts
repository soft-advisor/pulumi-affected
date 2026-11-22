import { type ProjectAnalysis } from './analysis/program.ts';
import { type Config, type CreateStacks } from './config.ts';
import { type DependencyGraph } from './graph.ts';
import { type Project, type Stack } from './projects.ts';
import { type Snapshot } from './snapshot.ts';
export interface SelectOptions {
    /** Any folder inside the repository */
    cwd: string;
    /** The revision to compare against, e.g. the pull request's merge base */
    base: string;
    /** The revision to analyse; the working tree when omitted */
    head?: string;
    /**
     * Per-stack revisions to compare against instead of `base`, e.g. the commit each stack was
     * last deployed from. `null` means the stack was never deployed.
     */
    bases?: Record<string, string | null>;
    /** Stack patterns to select regardless of changes */
    run?: string[];
    /** Stack patterns to leave out unless also named in `run` */
    skip?: string[];
    /** Select every stack */
    all?: boolean;
    /** Text that may carry Pulumi-Affected-Run/Skip lines, e.g. a pull request description */
    messages?: string[];
    /** Only changes count: Pulumi-Affected-* lines in commits and messages are ignored */
    changesOnly?: boolean;
    config?: Config;
}
export interface SelectedStack extends Stack {
    /** Index of the wave this stack runs in */
    wave: number;
    reasons: string[];
}
export interface SelectResult {
    base: string;
    head: string;
    stacks: SelectedStack[];
    /** Selected stack ids grouped into waves that can run in parallel, in order */
    waves: string[][];
    /** Ids of stacks that weren't selected */
    unaffected: string[];
    /** Stacks a change affected but a Pulumi-Affected-Skip line or --skip left out */
    skipped: {
        id: string;
        source: string;
        reasons: string[];
    }[];
    /** Every stack id to the ids of the stacks it depends on */
    dependencies: Record<string, string[]>;
    /** Pulumi-Affected-Create-Stacks lines in the change, in the order they were found */
    createStacks: CreateRequest[];
    /**
     * Stack id → dependency id → the outputs it reads from that dependency, or "all" when that
     * can't be worked out (or the dependency comes from `dependsOn`)
     */
    outputsRead: OutputsRead;
    /**
     * Stacks that may read other stacks' outputs in ways analysis can't see (programs that aren't
     * JavaScript or TypeScript, stack names that can't be worked out) and have no `dependsOn`
     */
    unknownReaders: string[];
    warnings: string[];
}
export type OutputsRead = Record<string, Record<string, string[] | 'all'>>;
export declare const RUN_TRAILER = "Pulumi-Affected-Run";
export declare const SKIP_TRAILER = "Pulumi-Affected-Skip";
export declare function select(options: SelectOptions): SelectResult;
/**
 * Holds snapshots and analyses for one selection, so each project is analysed once per
 * revision however many stacks it has.
 */
export declare class Session {
    readonly warnings: string[];
    readonly graphWarnings: string[];
    /** Stacks that may read other stacks' outputs in ways analysis can't see */
    readonly unknownReaders: Set<string>;
    /** Stack id → dependency id → outputs read, filled in by dependencyGraph */
    private readonly outputsRead;
    private recordReads;
    outputsReadRecord(): OutputsRead;
    private readonly snapshots;
    private readonly analyses;
    private readonly lockfiles;
    private readonly changes;
    private readonly projectReasonCache;
    private readonly moduleCache;
    private readonly repoRoot;
    readonly head: Snapshot;
    private readonly config;
    constructor(repoRoot: string, head: Snapshot, config: Config);
    snapshot(commit: string): Snapshot;
    /** Paths whose content differs between `base` and head, with how they changed */
    changedFiles(base: string): Map<string, string>;
    private readonly references;
    /** The head program of a project, for following stack references across modules */
    private programReferences;
    analysis(snapshot: Snapshot, project: Project): ProjectAnalysis;
    private lockfile;
    /** Why a project's program differs between `base` and head; empty when it doesn't */
    projectReasons(project: Project, base: string): string[];
    private computeProjectReasons;
    /**
     * The fallback when analysis can't be complete: any change in the project's folder, or in the
     * folders where what analysis couldn't see most likely lives
     */
    private folderChanges;
    /**
     * Packages whose resolved identity (version, source, integrity, patch) differs between base and
     * head, among those the program loads and everything they depend on
     */
    private packageChanges;
    /** Why one stack, beyond its project, differs between `base` and head */
    stackReasons(project: Project, stack: Stack, base: string): string[];
    /** Edges from stack references in code and from `dependsOn` in the config */
    dependencyGraph(projects: Project[], stacks: Stack[]): DependencyGraph;
}
/** Turns differing facts into readable reasons */
export declare function describeFactChanges(before: ProjectAnalysis, after: ProjectAnalysis): string[];
export interface Request {
    pattern: string;
    /** Who or what asked, shown as the reason: "requested by <source>" */
    source: string;
}
/** A Pulumi-Affected-Create-Stacks line: when to create stacks, for these patterns (or all) */
export interface CreateRequest {
    mode: CreateStacks;
    patterns: string[];
    source: string;
}
/** The stacks in the repo and how they depend on each other, as of `head` */
export declare function readDependencyGraph(options: {
    cwd: string;
    head?: string;
    config?: Config;
}): {
    stacks: Stack[];
    graph: DependencyGraph;
    outputsRead: OutputsRead;
    unknownReaders: string[];
    warnings: string[];
};
