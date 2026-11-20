import { isDeepStrictEqual } from 'node:util';
import { glob } from './patterns.ts';

/*
 * Reads the JSON a `pulumi preview --json` prints and decides whether the stack would change.
 * Known noise can be ignored by resource type and property, for example a provider whose
 * `assumeRole` differs only because previews run with a read-only role.
 */

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

interface Step {
  op: string;
  urn: string;
  oldState?: { type?: string; outputs?: Record<string, unknown> | null } | null;
  newState?: { type?: string; outputs?: Record<string, unknown> | null } | null;
  diffReasons?: string[] | null;
  detailedDiff?: Record<string, unknown> | null;
}

export class ClassifyError extends Error {}

/** Classifies the output of `pulumi preview --json` (or the first document of `up --json`) */
export function classify(output: string, ignore: readonly IgnoreRule[] = []): Classification {
  const preview = parseFirstJson(output) as { steps?: Step[] } | undefined;
  if (!preview || !Array.isArray(preview.steps)) {
    throw new ClassifyError("Not the JSON of `pulumi preview --json`: there's no steps list");
  }

  const byUrn = new Map<string, ResourceChange>();
  const outputs: string[] = [];
  for (const step of preview.steps) {
    if (
      step.newState?.type === 'pulumi:pulumi:Stack' ||
      step.oldState?.type === 'pulumi:pulumi:Stack'
    ) {
      outputs.push(...changedOutputs(step));
    }
    if (NO_OP.has(step.op)) continue;
    const change = toChange(step);
    const existing = byUrn.get(step.urn);
    if (!existing || priority(change.op) < priority(existing.op)) byUrn.set(step.urn, change);
  }

  const changes: ResourceChange[] = [];
  const ignored: ResourceChange[] = [];
  for (const change of byUrn.values()) {
    if (REPLACEMENT_OPS.has(change.op)) change.op = 'replace';
    (isIgnored(change, ignore) ? ignored : changes).push(change);
  }
  const counts: Record<string, number> = {};
  for (const change of changes) counts[change.op] = (counts[change.op] ?? 0) + 1;

  return {
    changed: changes.length > 0 || outputs.length > 0,
    counts,
    changes,
    outputs,
    ignored,
  };
}

function toChange(step: Step): ResourceChange {
  const urnParts = step.urn.split('::');
  const type = step.newState?.type ?? step.oldState?.type ?? urnParts[2]?.split('$').pop() ?? '';
  const properties = new Set(step.diffReasons ?? []);
  for (const path of Object.keys(step.detailedDiff ?? {})) {
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

function changedOutputs(step: Step) {
  const before = step.oldState?.outputs ?? {};
  const after = step.newState?.outputs;
  // A preview often can't compute outputs yet; unknown isn't a change
  if (!after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !isDeepStrictEqual(before[key], after[key])).sort();
}

function priority(op: string) {
  const index = OP_PRIORITY.indexOf(op);
  return index === -1 ? OP_PRIORITY.length : index;
}

function isIgnored(change: ResourceChange, rules: readonly IgnoreRule[]) {
  if (change.op !== 'update') return false;
  return rules.some((rule) => {
    if (!glob(rule.type)(change.type)) return false;
    if (!rule.properties || rule.properties.length === 0) return true;
    // Without the list of differing properties, the change can't be shown to be noise
    if (change.properties.length === 0) return false;
    return change.properties.every((property) => rule.properties?.includes(property));
  });
}

/**
 * `pulumi up --json` prints the plan as one JSON document followed by streamed events, so only
 * the first complete JSON value is read.
 */
export function parseFirstJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  return undefined;
}

/** "+2 ~1 -1 ±1" style counts for summaries */
export function formatCounts(classification: Classification) {
  const symbols: Record<string, string> = { create: '+', update: '~', delete: '-', replace: '±' };
  const parts = Object.entries(classification.counts).map(
    ([op, count]) => `${symbols[op] ?? `${op} `}${count}`,
  );
  if (classification.outputs.length > 0)
    parts.push(`outputs: ${classification.outputs.join(', ')}`);
  return parts.length > 0 ? parts.join(' ') : 'no changes';
}
