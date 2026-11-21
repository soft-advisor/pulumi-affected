import { isDeepStrictEqual } from 'node:util';
import { glob } from "./patterns.js";
/** Operations that don't modify anything */
const NO_OP = new Set(['same', 'read', 'refresh']);
/** For a resource with several steps (a replacement is three), the one that describes it */
const OP_PRIORITY = [
    'replace',
    'create-replacement',
    'delete-replaced',
    'import-replacement',
    'create',
    'delete',
    'update',
    'import',
    'discard',
    'discard-replaced',
    'remove-pending-replace',
];
const REPLACEMENT_OPS = new Set([
    'replace',
    'create-replacement',
    'delete-replaced',
    'import-replacement',
]);
export class ClassifyError extends Error {
}
/** Classifies the output of `pulumi preview --json` (or the first document of `up --json`) */
export function classify(output, ignore = []) {
    const preview = parseFirstJson(output, (value) => Array.isArray(value.steps));
    if (!preview || !Array.isArray(preview.steps)) {
        throw new ClassifyError("Not the JSON of `pulumi preview --json`: there's no steps list");
    }
    const byUrn = new Map();
    const outputs = [];
    for (const step of preview.steps) {
        if (step.newState?.type === 'pulumi:pulumi:Stack' ||
            step.oldState?.type === 'pulumi:pulumi:Stack') {
            outputs.push(...changedOutputs(step));
        }
        // The stack itself is a resource too; creating it is bookkeeping, and its outputs are
        // compared above
        if (NO_OP.has(step.op) || isStackStep(step))
            continue;
        const change = toChange(step);
        const existing = byUrn.get(step.urn);
        if (!existing || priority(change.op) < priority(existing.op))
            byUrn.set(step.urn, change);
    }
    const changes = [];
    const ignored = [];
    for (const change of byUrn.values()) {
        if (REPLACEMENT_OPS.has(change.op))
            change.op = 'replace';
        (isIgnored(change, ignore) ? ignored : changes).push(change);
    }
    const counts = {};
    for (const change of changes)
        counts[change.op] = (counts[change.op] ?? 0) + 1;
    return {
        changed: changes.length > 0 || outputs.length > 0,
        counts,
        changes,
        outputs,
        ignored,
    };
}
function isStackStep(step) {
    const type = step.newState?.type ?? step.oldState?.type ?? step.urn.split('::')[2];
    return type === 'pulumi:pulumi:Stack';
}
function toChange(step) {
    const urnParts = step.urn.split('::');
    const type = step.newState?.type ?? step.oldState?.type ?? urnParts[2]?.split('$').pop() ?? '';
    // Top-level properties: providers report nested paths too (`assumeRole.roleArn`)
    const properties = new Set();
    for (const path of [...(step.diffReasons ?? []), ...Object.keys(step.detailedDiff ?? {})]) {
        properties.add(path.split(/[.[]/)[0]);
    }
    return {
        op: step.op,
        urn: step.urn,
        type,
        name: urnParts[urnParts.length - 1] ?? step.urn,
        properties: [...properties].sort(),
    };
}
function changedOutputs(step) {
    const before = step.oldState?.outputs ?? {};
    const after = step.newState?.outputs;
    // A preview often can't compute outputs yet; unknown isn't a change
    if (!after)
        return [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => !isDeepStrictEqual(before[key], after[key])).sort();
}
function priority(op) {
    const index = OP_PRIORITY.indexOf(op);
    return index === -1 ? OP_PRIORITY.length : index;
}
function isIgnored(change, rules) {
    if (change.op !== 'update')
        return false;
    return rules.some((rule) => {
        if (!glob(rule.type)(change.type))
            return false;
        if (!rule.properties || rule.properties.length === 0)
            return true;
        // Without the list of differing properties, the change can't be shown to be noise
        if (change.properties.length === 0)
            return false;
        return change.properties.every((property) => rule.properties?.includes(property));
    });
}
/**
 * The first JSON object in output that may have other lines around it: a wrapper script's banner
 * (even one containing braces) before Pulumi's JSON, and `pulumi up --json`'s event stream after.
 * `accept` picks the object that's wanted, e.g. one with a `steps` list; anything else is skipped.
 */
export function parseFirstJson(text, accept = () => true) {
    let from = 0;
    for (let attempts = 0; attempts < MAX_JSON_ATTEMPTS; attempts++) {
        const start = text.indexOf('{', from);
        if (start === -1)
            return undefined;
        const end = matchingBrace(text, start);
        if (end !== -1) {
            try {
                const value = JSON.parse(text.slice(start, end + 1));
                if (value && typeof value === 'object' && accept(value))
                    return value;
            }
            catch {
                // Not JSON after all, e.g. "Assuming role {deploy}"
            }
        }
        from = start + 1;
    }
    return undefined;
}
const MAX_JSON_ATTEMPTS = 200;
/** Where the object starting at `start` ends, honouring strings; -1 if it never does */
function matchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            depth++;
        else if (char === '}') {
            depth--;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
/** "+2 ~1 -1 ±1" style counts for summaries */
export function formatCounts(classification) {
    const symbols = { create: '+', update: '~', delete: '-', replace: '±' };
    const parts = Object.entries(classification.counts).map(([op, count]) => `${symbols[op] ?? `${op} `}${count}`);
    if (classification.outputs.length > 0)
        parts.push(`outputs: ${classification.outputs.join(', ')}`);
    return parts.length > 0 ? parts.join(' ') : 'no changes';
}
