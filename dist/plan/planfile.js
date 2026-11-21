import { glob } from "../patterns.js";
/*
 * What `apply` and `plan` read from Pulumi's plan files (`preview --save-plan`). A plan holds,
 * per resource URN, a goal: the inputs to add, update or delete, and for the stack itself the
 * outputs it will add, update or delete. The preview's JSON doesn't show stack outputs that
 * would change; the plan does.
 */
/** Pulumi's marker for a value it doesn't know yet; a plan accepts any value in its place */
export const UNKNOWN = '04da6b54-80e4-46f7-96ec-b56ff0331ba9';
export class PlanFileError extends Error {
}
function parse(text) {
    try {
        const plan = JSON.parse(text);
        if (plan && typeof plan === 'object')
            return plan;
    }
    catch {
        // Reported below
    }
    throw new PlanFileError("The plan file isn't JSON");
}
function keysOf(diff) {
    if (!diff)
        return [];
    const deletes = Array.isArray(diff.deletes) ? diff.deletes : Object.keys(diff.deletes ?? {});
    return [...Object.keys(diff.adds ?? {}), ...Object.keys(diff.updates ?? {}), ...deletes];
}
/** The stack outputs the plan adds, changes or removes */
export function stackOutputChanges(text) {
    const plan = parse(text);
    const changed = new Set();
    for (const resource of Object.values(plan.resourcePlans ?? {})) {
        if (resource.goal?.type !== 'pulumi:pulumi:Stack')
            continue;
        for (const key of keysOf(resource.goal.outputDiff))
            changed.add(key);
    }
    return [...changed].sort();
}
/** Of the changed stack outputs, those whose new value isn't known until applying */
export function unknownOutputChanges(text) {
    const plan = parse(text);
    const unknown = new Set();
    for (const resource of Object.values(plan.resourcePlans ?? {})) {
        if (resource.goal?.type !== 'pulumi:pulumi:Stack')
            continue;
        const diff = resource.goal.outputDiff;
        for (const part of [diff?.adds, diff?.updates]) {
            for (const [key, value] of Object.entries(part ?? {})) {
                if (JSON.stringify(value).includes(UNKNOWN))
                    unknown.add(key);
            }
        }
    }
    return [...unknown].sort();
}
/**
 * The plan with the properties that ignore rules name left open: any value is accepted for them.
 * This is what lets plans made with a read-only role apply with the deploy role, when the role
 * is a provider input. Only rules that list their properties relax anything; every other input
 * is still held to the plan. Returns the new text and the "<URN> <property>" pairs relaxed.
 */
export function relaxPlan(text, rules) {
    const specific = rules.filter((rule) => rule.properties && rule.properties.length > 0);
    const plan = parse(text);
    const relaxed = [];
    for (const [urn, resource] of Object.entries(plan.resourcePlans ?? {})) {
        const type = resource.goal?.type;
        const diff = resource.goal?.inputDiff;
        if (!type || !diff)
            continue;
        for (const rule of specific) {
            if (!glob(rule.type)(type))
                continue;
            for (const property of rule.properties ?? []) {
                let touched = false;
                for (const part of [diff.adds, diff.updates]) {
                    if (part && Object.hasOwn(part, property)) {
                        part[property] = UNKNOWN;
                        touched = true;
                    }
                }
                if (Array.isArray(diff.deletes) && diff.deletes.includes(property)) {
                    diff.deletes = diff.deletes.filter((key) => key !== property);
                    touched = true;
                }
                else if (diff.deletes &&
                    !Array.isArray(diff.deletes) &&
                    Object.hasOwn(diff.deletes, property)) {
                    delete diff.deletes[property];
                    touched = true;
                }
                if (touched)
                    relaxed.push(`${urn} ${property}`);
            }
        }
    }
    return { text: relaxed.length > 0 ? JSON.stringify(plan) : text, relaxed };
}
