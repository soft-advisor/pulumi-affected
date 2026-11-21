import { type PulumiRunner } from '../pulumi/runner.ts';
import { type SelectOptions } from '../select.ts';
import { type Manifest, type PlannedStack } from './manifest.ts';
import { type StaleRead } from './outputs.ts';
export interface ApplyOptions {
    /** Any folder inside the repository, checked out at the planned commit */
    cwd: string;
    /** The plan directory */
    directory: string;
    runner: PulumiRunner;
    concurrency: number;
    /** Stack patterns that may be applied; a plan for any other stack is refused */
    allow?: string[];
    /**
     * How the change was selected (its base, Pulumi-Affected-Run lines and so on). The selection
     * is worked out again from the commit, and a plan for a stack it doesn't select is refused.
     */
    select?: Omit<SelectOptions, 'cwd' | 'head' | 'config'>;
    /** Stop at the first stack that isn't applied, instead of applying every other one */
    failFast?: boolean;
    onFinish?: (result: StackApplyResult) => void;
}
export type ApplyOutcome = 
/** Applied now */
'applied'
/** An earlier run applied this plan */
 | 'already-applied'
/** The stack's state changed since the plan; nothing was applied */
 | 'refused' | 'failed'
/** A stack it depends on wasn't applied, or changes outputs this plan was made without */
 | 'skipped';
export interface StackApplyResult {
    id: string;
    outcome: ApplyOutcome;
    error?: string;
    /** Plan properties left open by ignore rules, as "<URN> <property>" */
    relaxed?: string[];
}
export interface ApplyResult {
    manifest: Manifest;
    stacks: StackApplyResult[];
    /** Stacks that read outputs the applied plans change, and need planning again */
    needsPlan: string[];
    /** The same, with the outputs each reads */
    followUps: StaleRead[];
    warnings: string[];
    ok: boolean;
}
export declare class ApplyError extends Error {
}
/** Tags the update with the plan and the code it's for, so a rerun recognises it */
export declare function updateMessage(stack: PlannedStack, tree: string): string;
export declare function applyPlans(options: ApplyOptions): Promise<ApplyResult>;
