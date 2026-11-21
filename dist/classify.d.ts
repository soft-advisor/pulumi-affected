export interface IgnoreRule {
    /** Resource type glob, e.g. "pulumi:providers:aws" */
    type: string;
    /** Top-level properties whose differences don't count; empty or absent means all of them */
    properties?: string[];
}
export interface ResourceChange {
    op: string;
    urn: string;
    type: string;
    name: string;
    /** Top-level properties that differ, when Pulumi reports them */
    properties: string[];
}
export interface Classification {
    changed: boolean;
    /** Resource count per operation, counting a replacement once */
    counts: Record<string, number>;
    changes: ResourceChange[];
    /** Stack outputs whose values differ, when the preview knows the new values */
    outputs: string[];
    /** Changes left out by ignore rules */
    ignored: ResourceChange[];
}
export declare class ClassifyError extends Error {
}
/** Classifies the output of `pulumi preview --json` (or the first document of `up --json`) */
export declare function classify(output: string, ignore?: readonly IgnoreRule[]): Classification;
/**
 * The first JSON object in output that may have other lines around it: a wrapper script's banner
 * (even one containing braces) before Pulumi's JSON, and `pulumi up --json`'s event stream after.
 * `accept` picks the object that's wanted, e.g. one with a `steps` list; anything else is skipped.
 */
export declare function parseFirstJson(text: string, accept?: (value: Record<string, unknown>) => boolean): unknown;
/** "+2 ~1 -1 ±1" style counts for summaries */
export declare function formatCounts(classification: Classification): string;
