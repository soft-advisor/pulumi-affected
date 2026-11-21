import type { Config } from './config.ts';
import { type Snapshot } from './snapshot.ts';
export interface Project {
    /** The `name` in Pulumi.yaml */
    name: string;
    /** Repo-relative folder holding Pulumi.yaml; "" for the repo root */
    dir: string;
    /** Path of Pulumi.yaml itself */
    file: string;
    runtime: string;
    /** `runtime.options` from Pulumi.yaml, such as `tsconfig` and `nodeargs` */
    runtimeOptions: Record<string, unknown>;
    /** The `main` option, relative to `dir`, if set */
    main: string | undefined;
    /** Folder holding Pulumi.<stack>.yaml files */
    stackConfigDir: string;
    stacks: Stack[];
}
export interface Stack {
    /** "<project name>/<stack>" */
    id: string;
    project: string;
    dir: string;
    stack: string;
    /** Path of Pulumi.<stack>.yaml, which may not exist yet */
    configFile: string;
}
export declare class ProjectError extends Error {
}
/** Finds every Pulumi project in the snapshot and its stacks */
export declare function discoverProjects(snapshot: Snapshot, config: Config, warnings?: string[]): Project[];
/** Reads one project; `file` is the path of its Pulumi.yaml */
export declare function readProject(snapshot: Snapshot, file: string, warnings?: string[]): Project;
interface ProjectSettings {
    name: string;
    runtime: string;
    runtimeOptions: Record<string, unknown>;
    main?: string;
    stackConfigDir?: string;
}
export declare function parseProjectFile(text: string, file: string): ProjectSettings;
export {};
