import type { Project } from '../projects.ts';
import { type Snapshot } from '../snapshot.ts';
import { type EvaluationContext } from './evaluate.ts';
import { type ModuleInfo, type StackReferenceUse } from './module.ts';
export interface ProjectAnalysis {
    /** Fact key → value; a project changed when any fact differs between base and head */
    facts: Map<string, string>;
    /** Module path → the import chain from the entry file that loads it */
    chains: Map<string, string[]>;
    /** npm package name → files that load it */
    packages: Map<string, Set<string>>;
    stackReferences: {
        module: ModuleInfo;
        use: StackReferenceUse;
    }[];
    /** Paths of the modules the program loads */
    modules: string[];
    /**
     * Where analysis may have missed inputs (a computed `require`, an unresolvable import, a file
     * read whose path can't be worked out). Selection then also counts any change in the project
     * folder and in each gap's folder.
     */
    gaps: Gap[];
    entry: string | undefined;
    /** The folder Pulumi runs the program in: `main` when it's a folder, else the project's */
    programDir: string;
    /** Finds constants in this snapshot's modules, for evaluating stack reference names */
    lookup: EvaluationContext['lookup'];
    /** Resolves an import to a repository file, as this analysis does */
    resolveFile(specifier: string, from: string): string | undefined;
}
export interface Gap {
    message: string;
    /** The folder where whatever analysis couldn't see most likely lives */
    dir: string;
}
/** Parsed modules shared across projects and snapshots, keyed by content and compiler options */
export type ModuleCache = Map<string, ModuleInfo>;
export declare function analyzeProject(snapshot: Snapshot, project: Project, cache: ModuleCache): ProjectAnalysis;
/**
 * The folder Pulumi runs the program in: `main`'s folder when `main` names a file (even build
 * output that isn't committed), `main` itself when it's a folder, else the project folder
 */
export declare function programDirOf(snapshot: Snapshot, project: Project): string;
