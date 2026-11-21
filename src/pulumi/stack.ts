import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  type CommandResult,
  errorText,
  isMissingStack,
  type PulumiRunner,
  parseJsonArray,
  parseLastJsonObject,
  type StackTarget,
} from './runner.ts';

/*
 * What a stack's state is, as far as plans care. Pulumi checks that a plan's resource operations
 * still happen, not that the state is the one the plan was made from, so an older plan could
 * apply over newer state. A fingerprint of the exported resources, taken when planning and again
 * before applying, catches that. The history's version number would be simpler, but
 * self-managed backends always record 0.
 */

export type StateFingerprint = { kind: 'exists'; fingerprint: string } | { kind: 'missing' };

export class StackError extends Error {}

export async function stateFingerprint(
  runner: PulumiRunner,
  stack: StackTarget,
): Promise<StateFingerprint> {
  const result = await runner.run(stack, ['stack', 'export']);
  if (isMissingStack(result)) return { kind: 'missing' };
  if (result.code !== 0) throw failure(stack, "can't export the stack's state", result);
  const exported = parseLastJsonObject(result.stdout) as
    | { deployment?: { resources?: unknown; pending_operations?: unknown } }
    | undefined;
  if (!exported) throw new StackError(`${stack.id}: the stack export isn't JSON`);
  // Resources and pending operations are the state; the export's own timestamps aren't
  const state = JSON.stringify([
    exported?.deployment?.resources ?? [],
    exported?.deployment?.pending_operations ?? [],
  ]);
  return { kind: 'exists', fingerprint: createHash('sha256').update(state).digest('hex') };
}

interface HistoryEntry {
  kind?: string;
  result?: string;
  message?: string;
}

/** The stack's newest history entries, newest first */
export async function recentUpdates(runner: PulumiRunner, stack: StackTarget, count = 25) {
  const result = await runner.run(stack, [
    'stack',
    'history',
    '--json',
    '--page-size',
    String(count),
  ]);
  if (result.code !== 0) throw failure(stack, "can't read the stack's history", result);
  const entries = parseJsonArray<HistoryEntry>(result.stdout);
  if (!entries) throw new StackError(`${stack.id}: the stack history isn't JSON`);
  return entries;
}

/** Stack outputs including secrets, compared in memory only and never printed */
export async function readOutputs(runner: PulumiRunner, stack: StackTarget) {
  const result = await runner.run(stack, ['stack', 'output', '--json', '--show-secrets']);
  if (isMissingStack(result)) return {};
  if (result.code !== 0) throw failure(stack, "can't read the stack's outputs", result);
  const parsed = parseLastJsonObject(result.stdout || '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** The secrets provider a stack's config file names, other than the passphrase default */
export function secretsProviderOf(config: string | undefined) {
  if (!config) return undefined;
  try {
    const value = (parseYaml(config) as { secretsprovider?: unknown } | null)?.secretsprovider;
    return typeof value === 'string' && value !== 'passphrase' ? value : undefined;
  } catch {
    return undefined;
  }
}

function failure(stack: StackTarget, what: string, result: CommandResult) {
  return new StackError(`${stack.id}: ${what}: ${errorText(result)}`);
}
