import type { ResourceChange } from '../classify.ts';
import type { StaleRead } from './outputs.ts';
export declare const MANIFEST_FILE = "manifest.json";
export declare const COMMENT_FILE = "comment.md";
declare const MANIFEST_VERSION = 2;
export interface PlannedStack {
    id: string;
    project: string;
    /** Repo-relative folder; "" for the repository root */
    dir: string;
    stack: string;
    wave: number;
    /**
     * A hash of the stack's state when planned; applying refuses any other state. Absent for a
     * stack created on apply, which didn't exist when planned.
     */
    fingerprint?: string;
    /** Whether `plan` created the stack, empty, to plan it */
    created: boolean;
    /**
     * The stack didn't exist and is created when applying (`create-stacks: apply`). It was planned
     * in a temporary backend, and its plan creates no resources.
     */
    createOnApply?: boolean;
    /**
     * The passphrase encryption salt Pulumi wrote into the config file of a stack `plan` created.
     * The plan's secrets are encrypted with it, so `apply` restores it in a checkout without one.
     */
    encryptionSalt?: string;
    /** File names in the plan directory */
    plan: string;
    preview: string;
    /** sha256 of the plan file */
    planHash: string;
    counts: Record<string, number>;
    changes: ResourceChange[];
    /** Stack outputs the plan adds, changes or removes */
    outputs: string[];
    /** Of those, the ones whose new value is only known once applied */
    unknownOutputs?: string[];
    reasons: string[];
}
export interface Manifest {
    version: typeof MANIFEST_VERSION;
    /**
     * `preview` when only previewed (plan's `mode: preview`): the plan files aren't kept, and the
     * manifest only tells `up` which stacks had changes
     */
    mode?: 'preview';
    /** The git tree that was planned: only exactly this code may apply the plans */
    tree: string;
    head: string;
    base: string;
    pulumiVersion: string;
    /** Plans to apply, with changes */
    stacks: PlannedStack[];
    /** Previewed, nothing to apply */
    unchanged: {
        id: string;
        reasons: string[];
    }[];
    /** Stacks that couldn't be planned; `blockedBy` when they read outputs another plan changes */
    failed: {
        id: string;
        error: string;
        reasons: string[];
        blockedBy?: StaleRead[];
    }[];
    skipped: {
        id: string;
        source: string;
        reasons: string[];
    }[];
    /** Stacks a Pulumi-Affected-Force-Up line asks to deploy even without changes (mode preview) */
    forceUp?: string[];
    /** Stacks that read outputs these plans change, to plan again once they're applied */
    followUps: StaleRead[];
    /** Stack id → ids of the stacks it depends on, for the report */
    dependencies: Record<string, string[]>;
    warnings: string[];
}
/** File names for a stack's plan; `+` can't appear in project or stack names, so they're unique */
export declare function planFileNames(id: string): {
    plan: string;
    preview: string;
};
export declare function hashFile(path: string): string;
export declare function hashText(content: string | Buffer): string;
export declare function writeManifest(directory: string, manifest: Manifest): void;
export declare class ManifestError extends Error {
}
/** Reads and checks a manifest, and the hash of every plan file it names */
export declare function readManifest(directory: string): Manifest;
/** What a preview found, as `up` uses it: which stacks had changes, and which had none */
export interface PreviewSummary {
    changed: Set<string>;
    unchanged: Set<string>;
    /** The commit previewed, if the manifest names a well-formed one */
    head?: string;
    /** The tree previewed: the same tree is the same code */
    tree?: string;
}
/**
 * Reads a preview manifest (plan's `mode: preview`). It comes from the job that ran the pull
 * request's code, so it's only used to skip stacks it says had no changes; anything it leaves
 * out is deployed.
 */
export declare function readPreviewSummary(directory: string): PreviewSummary;
export {};
