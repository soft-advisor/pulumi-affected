import type { IgnoreRule } from './classify.ts';
import type { Snapshot } from './snapshot.ts';
export declare const CONFIG_FILE = "pulumi-affected.yaml";
export interface Config {
    projects: {
        include: string[];
        exclude: string[];
    };
    stacks: string[];
    /**
     * Dependencies analysis can't see: stack patterns, each of whose outputs may be read, or stack
     * patterns mapped to the outputs that stand for what's read
     */
    dependsOn: Record<string, string[] | Record<string, string[]>>;
    after: Record<string, string[]>;
    rules: {
        when: string[];
        run: string[];
    }[];
    always: string[];
    inputs: Record<string, string[]>;
    globalInputs: string[];
    packages: {
        ignore: string[];
    };
    classify: {
        ignore: IgnoreRule[];
    };
    createStacks: CreateStacksConfig;
    /**
     * With plan's `mode: preview` and apply's `mode: up`: deploy the stacks that read outputs a
     * deploy changed, after it (`up`), or only list them (`warn`)
     */
    outputReaders?: 'up' | 'warn';
}
export type CreateStacks = 'plan' | 'apply';
/** When stacks that don't exist yet are created: a default, and stack patterns that differ */
export interface CreateStacksConfig {
    default?: CreateStacks;
    plan: string[];
    apply: string[];
}
export declare function defaultConfig(): Config;
export declare class ConfigError extends Error {
}
/** Reads pulumi-affected.yaml from the snapshot's repo root; a missing file means defaults */
export declare function loadConfig(snapshot: Snapshot, path?: string): Config;
export declare function parseConfig(text: string, path?: string): Config;
