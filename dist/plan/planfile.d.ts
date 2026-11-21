import type { IgnoreRule } from '../classify.ts';
/** Pulumi's marker for a value it doesn't know yet; a plan accepts any value in its place */
export declare const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";
export declare class PlanFileError extends Error {
}
/** The stack outputs the plan adds, changes or removes */
export declare function stackOutputChanges(text: string): string[];
/** Of the changed stack outputs, those whose new value isn't known until applying */
export declare function unknownOutputChanges(text: string): string[];
/**
 * The plan with the properties that ignore rules name left open: any value is accepted for them.
 * This is what lets plans made with a read-only role apply with the deploy role, when the role
 * is a provider input. Only rules that list their properties relax anything; every other input
 * is still held to the plan. Returns the new text and the "<URN> <property>" pairs relaxed.
 */
export declare function relaxPlan(text: string, rules: readonly IgnoreRule[]): {
    text: string;
    relaxed: string[];
};
/** Whether a plan holds encrypted values, which only the secrets manager it was made with reads */
export declare function planHasSecrets(text: string): boolean;
/** Whether a plan creates nothing but the stack itself */
export declare function createsOnlyTheStack(text: string): boolean;
