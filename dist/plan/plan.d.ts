import { type Config, type CreateStacks } from '../config.ts';
import { type PulumiRunner } from '../pulumi/runner.ts';
import { type CreateRequest, type SelectedStack, type SelectOptions } from '../select.ts';
import { type StaleRead } from './outputs.ts';
import { type Manifest, type PlannedStack } from './manifest.ts';
export interface PlanOptions {
    select: Omit<SelectOptions, 'head'>;
    /** Where to write plans, previews and the manifest */
    directory: string;
    runner: PulumiRunner;
    concurrency: number;
    /** When stacks that don't exist yet are created, unless the config or the change says */
    createStacks?: CreateStacks;
    /** Stop planning at the first stack that fails, instead of planning every other one */
    failFast?: boolean;
    onFinish?: (outcome: StackOutcome) => void;
}
export type StackOutcome = {
    kind: 'planned';
    stack: PlannedStack;
} | {
    kind: 'unchanged';
    id: string;
    reasons: string[];
} | {
    kind: 'failed';
    id: string;
    error: string;
    reasons: string[];
    blockedBy?: StaleRead[];
};
export declare function planStacks(options: PlanOptions): Promise<Manifest>;
/**
 * When a stack that doesn't exist yet is created: a Pulumi-Affected-Create-Stacks line in the
 * change (the last one naming it), else the config's patterns (plan's first), else the
 * config's default, else the action's input, else when planning
 */
export declare function createModeFor(stack: SelectedStack, requests: readonly CreateRequest[], config: Config, options: {
    createStacks?: CreateStacks;
}): CreateStacks;
/** `stack init`, with the secrets provider the stack's config file names */
export declare function initArgs(repoRoot: string, configFile: string): string[];
/**
 * Writes a passphrase stack's encryption salt into its config file when the file has none.
 * Pulumi only reads the salt from there, and makes a new one when it's missing, so a checkout
 * without the salt (one Pulumi wrote on another runner) couldn't decrypt the stack's secrets.
 */
export declare function writeSalt(configPath: string, salt: string | undefined): void;
/** The `encryptionsalt` in a stack's config file, if any */
export declare function encryptionSaltOf(path: string): string | undefined;
export declare function pulumiVersion(runner: PulumiRunner): Promise<string>;
/** That stacks whose references can't be analysed may need planning once outputs change */
export declare function unknownReadersWarning(changed: {
    id: string;
}[], readers: string[]): string;
