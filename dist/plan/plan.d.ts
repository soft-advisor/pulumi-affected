import { type PulumiRunner } from '../pulumi/runner.ts';
import { type SelectOptions } from '../select.ts';
import { type StaleRead } from './outputs.ts';
import { type Manifest, type PlannedStack } from './manifest.ts';
export interface PlanOptions {
    select: Omit<SelectOptions, 'head'>;
    /** Where to write plans, previews and the manifest */
    directory: string;
    runner: PulumiRunner;
    concurrency: number;
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
/** `stack init`, with the secrets provider the stack's config file names */
export declare function initArgs(repoRoot: string, configFile: string): string[];
/** The `encryptionsalt` in a stack's config file, if any */
export declare function encryptionSaltOf(path: string): string | undefined;
export declare function pulumiVersion(runner: PulumiRunner): Promise<string>;
/** That stacks whose references can't be analysed may need planning once outputs change */
export declare function unknownReadersWarning(changed: {
    id: string;
}[], readers: string[]): string;
