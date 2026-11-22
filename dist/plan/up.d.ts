import { type PulumiRunner } from '../pulumi/runner.ts';
import { type SelectOptions } from '../select.ts';
import type { PreviewSummary } from './manifest.ts';
import type { StaleRead } from './outputs.ts';
export type OutputReaders = 'up' | 'warn';
export interface UpOptions {
    /** Any folder inside the repository, checked out at the merged commit */
    cwd: string;
    runner: PulumiRunner;
    concurrency: number;
    /** How the change was selected, as the preview selected it */
    select: Omit<SelectOptions, 'cwd' | 'head' | 'config'>;
    /** What the pull request's preview found; without it, every selected stack is deployed */
    previews?: PreviewSummary;
    /** Deploy stacks that read outputs a deploy changed (`up`), or only list them (`warn`) */
    outputReaders: OutputReaders;
    /** Stack patterns that may be deployed */
    allow?: string[];
    /**
     * Fetches a commit that isn't in the checkout (the previewed one is usually GitHub's merge
     * commit for the pull request, on no branch), returning whether it's there now
     */
    fetchCommit?: (sha: string) => boolean;
    failFast?: boolean;
    onFinish?: (result: StackUpResult) => void;
}
export type UpOutcome = 
/** Deployed */
'applied'
/** Selected, but its preview showed no changes */
 | 'unchanged' | 'failed'
/** A stack it depends on failed, or an earlier one did (fail-fast) */
 | 'skipped';
export interface StackUpResult {
    id: string;
    outcome: UpOutcome;
    error?: string;
    /** Resources per operation, from the update */
    counts?: Record<string, number>;
    /** Outputs the update changed */
    outputs?: string[];
    /** Why it's deployed when the change didn't select it: outputs it reads changed */
    readsChanged?: StaleRead[];
}
export interface UpResult {
    stacks: StackUpResult[];
    /** Stacks reading outputs that changed, left to deploy later (`outputReaders: warn`) */
    followUps: StaleRead[];
    warnings: string[];
    ok: boolean;
}
export declare function upStacks(options: UpOptions): Promise<UpResult>;
