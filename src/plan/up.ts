import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../config.ts';
import { CycleError, computeWaves, type DependencyGraph, dependentsOf } from '../graph.ts';
import { matchesAnyStack } from '../patterns.ts';
import { errorText, type PulumiRunner } from '../pulumi/runner.ts';
import { readOutputs, recentUpdates, stateFingerprint } from '../pulumi/stack.ts';
import { readDependencyGraph, type SelectOptions, select } from '../select.ts';
import { GitSnapshot, repoRootOf, resolveCommit } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import type { PreviewSummary } from './manifest.ts';
import type { StaleRead } from './outputs.ts';
import { initArgs, unknownReadersWarning, writeSalt } from './plan.ts';

/*
 * Deploys a merged change with `pulumi up`, for repositories that preview on the pull request
 * rather than save plans (plan's `mode: preview`). Less strict than applying plans: what's
 * deployed is the merged code against the state as it is now, which can differ from what the
 * preview showed if either moved on.
 *
 * Which stacks: the ones the change selects, worked out again from the merged commit, except
 * those the preview found no changes in. A stack whose outputs change takes the stacks that read
 * those outputs with it (`outputReaders: up`), after it, so they pick up the new values; or they
 * are only listed, to deploy later (`warn`). Everything runs in dependency order.
 */

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
  failFast?: boolean;
  onFinish?: (result: StackUpResult) => void;
}

export type UpOutcome =
  /** Deployed */
  | 'applied'
  /** Selected, but its preview showed no changes */
  | 'unchanged'
  | 'failed'
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

const RAN = new Set<UpOutcome>(['applied', 'unchanged']);

export async function upStacks(options: UpOptions): Promise<UpResult> {
  const repoRoot = repoRootOf(options.cwd);
  const commit = resolveCommit(repoRoot, 'HEAD');
  const config = loadConfig(new GitSnapshot(repoRoot, commit));
  const selection = select({ ...options.select, cwd: repoRoot, head: commit, config });
  const {
    stacks: known,
    graph,
    outputsRead,
    unknownReaders,
  } = readDependencyGraph({
    cwd: repoRoot,
    head: commit,
    config,
  });
  const byId = new Map(known.map((stack) => [stack.id, stack]));
  const allowed = (id: string) => {
    const stack = byId.get(id);
    return stack !== undefined && (!options.allow || matchesAnyStack(options.allow, stack));
  };

  // Selected stacks to deploy, and why; the preview can only take some out
  const toRun = new Map<string, StaleRead[] | undefined>();
  const results = new Map<string, StackUpResult>();
  for (const stack of selection.stacks) {
    if (options.previews?.unchanged.has(stack.id)) {
      results.set(stack.id, { id: stack.id, outcome: 'unchanged' });
    } else {
      toRun.set(stack.id, undefined);
    }
  }

  const warnings: string[] = [];
  const followUps: StaleRead[] = [];
  const changedOutputs: { id: string }[] = [];
  let failed = false;
  for (const wave of orderedWaves(
    graph,
    known.map((stack) => stack.id),
  )) {
    const stacks = wave.filter((id) => toRun.has(id));
    await mapConcurrently(stacks, options.concurrency, async (id) => {
      const stack = byId.get(id);
      let result: StackUpResult;
      if (!stack) {
        result = { id, outcome: 'failed', error: "it isn't a stack this commit defines" };
      } else if (!allowed(id)) {
        result = { id, outcome: 'failed', error: "it isn't one of the stacks allowed to deploy" };
      } else if (options.failFast && failed) {
        result = {
          id,
          outcome: 'skipped',
          error: 'not tried: an earlier stack failed (fail-fast)',
        };
      } else {
        const blocked = [...(graph.get(id) ?? [])].filter((dependency) => {
          const outcome = results.get(dependency)?.outcome;
          return outcome !== undefined && !RAN.has(outcome);
        });
        result = blocked.length
          ? { id, outcome: 'skipped', error: `not deployed: ${blocked.join(', ')}` }
          : await upStack(stack, repoRoot, dependentsOf(graph, id).length > 0, options.runner);
      }
      const readsChanged = toRun.get(id);
      if (readsChanged) result.readsChanged = readsChanged;
      if (result.outcome === 'failed') failed = true;
      results.set(id, result);

      // Stacks reading outputs this update changed were deployed with the old values
      if (result.outputs?.length) {
        changedOutputs.push({ id });
        for (const dependent of dependentsOf(graph, id)) {
          const reads = outputsRead[dependent]?.[id] ?? 'all';
          const read =
            reads === 'all' ? result.outputs : result.outputs.filter((key) => reads.includes(key));
          if (read.length === 0) continue;
          const stale: StaleRead = {
            id: dependent,
            dependency: id,
            outputs: read,
            certain: reads !== 'all',
          };
          if (options.outputReaders === 'up' && allowed(dependent)) {
            // It comes in a later wave, as it depends on this stack
            toRun.set(dependent, [...(toRun.get(dependent) ?? []), stale]);
            if (results.get(dependent)?.outcome === 'unchanged') results.delete(dependent);
          } else {
            followUps.push(stale);
          }
        }
      }
      options.onFinish?.(result);
    });
  }
  if (changedOutputs.length > 0 && unknownReaders.length > 0) {
    warnings.push(unknownReadersWarning(changedOutputs, unknownReaders));
  }

  const order = known.map((stack) => stack.id);
  const stacks = [...results.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    stacks,
    followUps,
    warnings,
    ok: stacks.every((stack) => RAN.has(stack.outcome)),
  };
}

/** Waves over every stack, so readers of changed outputs come after what they read */
function orderedWaves(graph: DependencyGraph, ids: string[]) {
  try {
    return computeWaves(graph, ids);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
    return [...ids].sort().map((id) => [id]);
  }
}

async function upStack(
  stack: { id: string; project: string; dir: string; stack: string; configFile: string },
  repoRoot: string,
  hasDependents: boolean,
  runner: PulumiRunner,
): Promise<StackUpResult> {
  const fail = (error: string): StackUpResult => ({ id: stack.id, outcome: 'failed', error });
  try {
    const configPath = join(repoRoot, stack.configFile);
    const current = await stateFingerprint(runner, stack);
    if (current.kind === 'missing') {
      const init = await runner.run(stack, initArgs(repoRoot, stack.configFile));
      if (init.code !== 0) return fail(`couldn't create the stack: ${errorText(init)}`);
    } else {
      writeSalt(configPath, current.salt);
    }
    // Outputs are only compared for stacks others read
    const before = hasDependents ? await readOutputs(runner, stack) : undefined;
    const up = await runner.run(stack, ['up', '--yes', '--non-interactive', '--skip-preview']);
    if (up.code !== 0) return fail(errorText(up));
    const counts = (await recentUpdates(runner, stack, 1))[0]?.resourceChanges;
    const result: StackUpResult = {
      id: stack.id,
      outcome: 'applied',
      ...(counts ? { counts } : {}),
    };
    if (before !== undefined) {
      const after = await readOutputs(runner, stack);
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const outputs = [...keys].filter((key) => !isDeepStrictEqual(before[key], after[key])).sort();
      if (outputs.length > 0) result.outputs = outputs;
    }
    return result;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
