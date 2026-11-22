import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../config.ts';
import { dependentsOf } from '../graph.ts';
import { matchesAnyStack } from '../patterns.ts';
import { errorText, type PulumiRunner } from '../pulumi/runner.ts';
import { readOutputs, recentUpdates, stateFingerprint } from '../pulumi/stack.ts';
import { readDependencyGraph, type SelectOptions, select } from '../select.ts';
import { ensureCommit, GitSnapshot, git, repoRootOf, resolveCommit } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import type { PreviewSummary } from './manifest.ts';
import { missingDeclaredOutputs, type StaleRead } from './outputs.ts';
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
  /** Every output the stack has after the update, when they were read */
  exported?: string[];
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
    declaredOutputs,
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
  const refused = selection.stacks.filter((stack) => !allowed(stack.id));
  if (refused.length > 0) {
    throw new Error(
      `${refused.map((stack) => stack.id).join(', ')} ${refused.length === 1 ? 'is' : 'are'} selected but not among the stacks allowed to deploy`,
    );
  }

  // The preview's "no changes" only holds for the code it previewed: a stack that changed since
  // (main moved on, or a deploy in between failed) is deployed anyway. The same tree is the same
  // code, which is the usual case and needs nothing fetched.
  const warnings: string[] = [];
  const unchanged = new Set(options.previews?.unchanged ?? []);
  const previews = options.previews;
  const tree = git(repoRoot, ['rev-parse', `${commit}^{tree}`]).trim();
  if (previews && unchanged.size > 0 && previews.tree !== tree) {
    const available =
      previews.head !== undefined &&
      (ensureCommit(repoRoot, previews.head) || options.fetchCommit?.(previews.head) === true);
    const since = available ? changedSince(repoRoot, previews.head, commit, config) : undefined;
    if (since === undefined) {
      warnings.push(
        `The previewed commit${previews.head ? ` ${previews.head.slice(0, 7)}` : ''} can't be compared with this one, so its "no changes" isn't trusted: every selected stack is deployed (${[...unchanged].join(', ')} included)`,
      );
      unchanged.clear();
    } else {
      for (const id of since) unchanged.delete(id);
    }
  }

  // Selected stacks to deploy, and why; the preview can only take some out
  const toRun = new Map<string, StaleRead[] | undefined>();
  const results = new Map<string, StackUpResult>();
  for (const stack of selection.stacks) {
    if (unchanged.has(stack.id)) results.set(stack.id, { id: stack.id, outcome: 'unchanged' });
    else toRun.set(stack.id, undefined);
  }

  const followUps: StaleRead[] = [];
  const changedOutputs: { id: string }[] = [];
  let failed = false;
  const done = (id: string) => {
    const outcome = results.get(id)?.outcome;
    return outcome !== undefined && outcome !== 'unchanged';
  };
  const pending = () => [...toRun.keys()].filter((id) => !done(id));
  // A stack runs once the stacks it depends on that are being deployed have run. Readers added
  // along the way are scheduled the same way, so they always come after what they read; in a
  // cycle, the stack waiting on the fewest others goes first.
  for (let waiting = pending(); waiting.length > 0; waiting = pending()) {
    const blockers = (id: string) =>
      [...(graph.get(id) ?? [])].filter((dependency) => waiting.includes(dependency));
    let ready = waiting.filter((id) => blockers(id).length === 0);
    if (ready.length === 0) {
      ready = [
        [...waiting].sort(
          (a, b) => blockers(a).length - blockers(b).length || a.localeCompare(b),
        )[0],
      ];
    }
    await mapConcurrently(ready.sort(), options.concurrency, async (id) => {
      const stack = byId.get(id);
      let result: StackUpResult;
      if (!stack) {
        result = { id, outcome: 'failed', error: "it isn't a stack this commit defines" };
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
      if (result.exported) {
        warnings.push(...missingDeclaredOutputs(id, result.exported, declaredOutputs));
      }

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
          const comesLater = toRun.has(dependent) && !done(dependent);
          if (options.outputReaders === 'up' && allowed(dependent) && !done(dependent)) {
            toRun.set(dependent, [...(toRun.get(dependent) ?? []), stale]);
            if (results.get(dependent)?.outcome === 'unchanged') results.delete(dependent);
          } else if (!comesLater) {
            // Deployed already (in a cycle), or not at all: it needs deploying again
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

/**
 * The stacks a change from the previewed commit to this one selects, or undefined when that
 * commit can't be found (then nothing the preview says is trusted)
 */
function changedSince(
  repoRoot: string,
  previewed: string | undefined,
  commit: string,
  config: ReturnType<typeof loadConfig>,
) {
  if (!previewed) return undefined;
  try {
    // Only what changed in code and config: the merge commit repeats the request lines
    return new Set(
      select({
        cwd: repoRoot,
        base: previewed,
        head: commit,
        config,
        changesOnly: true,
      }).stacks.map((stack) => stack.id),
    );
  } catch {
    return undefined;
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
      result.exported = Object.keys(after).sort();
      if (outputs.length > 0) result.outputs = outputs;
    }
    return result;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
