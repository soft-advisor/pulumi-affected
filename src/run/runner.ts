import type { Classification, IgnoreRule } from '../classify.ts';
import { type DependencyGraph, dependentsOf } from '../graph.ts';
import type { Stack } from '../projects.ts';
import { type NewStacks, type PulumiRunner, previewStack, upStack } from './pulumi.ts';

/*
 * Runs previews or deploys for selected stacks.
 *
 * Previews run in any order, since each reads the other stacks' outputs as they are now.
 * Deploys run a stack only after every stack it depends on that's also running. When a deploy
 * changes a stack's outputs, the stacks reading them are deployed too, even if nothing selected
 * them, because their inputs just changed.
 */

export type Mode = 'preview' | 'up';

export type StackStatus = 'changes' | 'no-changes' | 'failed' | 'skipped';

export interface StackRun {
  stack: Stack;
  status: StackStatus;
  /** Why the stack ran */
  reasons: string[];
  classification?: Classification;
  /** Up only: outputs whose values changed */
  changedOutputs?: string[];
  newStack?: boolean;
  /** Things to act on, shown with the stack's result */
  notes?: string[];
  error?: string;
}

export interface RunOptions {
  mode: Mode;
  stacks: { stack: Stack; reasons: string[] }[];
  /** Every stack in the repo, to look up dependents added during deploys */
  allStacks: Stack[];
  graph: DependencyGraph;
  runner: PulumiRunner;
  repoRoot: string;
  ignore: readonly IgnoreRule[];
  concurrency: number;
  failFast: boolean;
  /** Whether stacks that don't exist yet are previewed in a temporary backend or left out */
  newStacks?: NewStacks;
  /** Whether deploys may create stacks that don't exist yet */
  createStacks?: boolean;
  /** Called as each stack finishes, e.g. to print its log */
  onFinish?: (run: StackRun) => void;
}

export async function runStacks(options: RunOptions): Promise<StackRun[]> {
  return options.mode === 'preview' ? runPreviews(options) : runDeploys(options);
}

async function runPreviews(options: RunOptions) {
  let stop = false;
  const runs = await mapConcurrently(
    options.stacks,
    options.concurrency,
    async ({ stack, reasons }) => {
      if (stop)
        return finish(options, {
          stack,
          reasons,
          status: 'skipped',
          error: 'an earlier stack failed',
        });
      const outcome = await previewStack(
        options.runner,
        stack,
        options.repoRoot,
        options.ignore,
        options.newStacks,
      );
      if (outcome.kind === 'new-stack-skipped') {
        return finish(options, {
          stack,
          reasons,
          status: 'skipped',
          newStack: true,
          error: "doesn't exist yet, and run.newStacks is skip",
        });
      }
      if (outcome.kind === 'failed') {
        if (options.failFast) stop = true;
        return finish(options, {
          stack,
          reasons,
          status: 'failed',
          error: outcome.error,
          newStack: outcome.newStack,
        });
      }
      return finish(options, {
        stack,
        reasons,
        status: outcome.classification.changed ? 'changes' : 'no-changes',
        classification: outcome.classification,
        newStack: outcome.newStack,
      });
    },
  );
  return runs;
}

async function runDeploys(options: RunOptions) {
  const byId = new Map(options.allStacks.map((stack) => [stack.id, stack]));
  const pending = new Map(options.stacks.map((entry) => [entry.stack.id, entry]));
  const runs = new Map<string, StackRun>();
  const failed = new Set<string>();
  let stop = false;

  /** True when a stack it depends on, directly or not, failed in this run */
  const dependsOnFailure = (id: string) => {
    const seen = new Set<string>();
    const queue = [...(options.graph.get(id) ?? [])];
    while (queue.length > 0) {
      const dependency = queue.shift() as string;
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      if (failed.has(dependency)) return dependency;
      queue.push(...(options.graph.get(dependency) ?? []));
    }
    return undefined;
  };

  /**
   * A stack added because its inputs changed isn't selected again by later pushes, so if it can't
   * run now, someone has to run it
   */
  const missedInputsNote = (reasons: string[]) =>
    reasons.some((reason) => reason.includes(' outputs changed: '))
      ? '; its inputs changed in this run, so run it again (e.g. Pulumi-Affected-Run) once that is fixed'
      : '';

  /** True when `id` must wait: a stack it depends on, directly or not, is still pending */
  const isBlocked = (id: string) => {
    const seen = new Set<string>();
    const queue = [...(options.graph.get(id) ?? [])];
    while (queue.length > 0) {
      const dependency = queue.shift() as string;
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      if (pending.has(dependency)) return true;
      queue.push(...(options.graph.get(dependency) ?? []));
    }
    return false;
  };

  /** The pending stacks that depend on a failed one never run */
  const skipDependentsOf = (id: string) => {
    for (const dependent of dependentsOf(options.graph, id, true)) {
      const entry = pending.get(dependent);
      if (!entry) continue;
      pending.delete(dependent);
      runs.set(
        dependent,
        finish(options, {
          ...entry,
          status: 'skipped',
          error: `${id} failed, and this stack depends on it${missedInputsNote(entry.reasons)}`,
        }),
      );
    }
  };

  while (pending.size > 0) {
    const ready = [...pending.values()].filter((entry) => !isBlocked(entry.stack.id));
    if (ready.length === 0)
      throw new Error(`Stacks wait on each other: ${[...pending.keys()].join(', ')}`);
    for (const entry of ready) pending.delete(entry.stack.id);

    const finished = await mapConcurrently(
      ready,
      options.concurrency,
      async ({ stack, reasons }) => {
        if (stop)
          return finish(options, {
            stack,
            reasons,
            status: 'skipped',
            error: 'an earlier stack failed',
          });
        const outcome = await upStack(
          options.runner,
          stack,
          options.repoRoot,
          options.ignore,
          options.createStacks ?? true,
        );
        if (outcome.kind === 'failed') {
          if (options.failFast) stop = true;
          return finish(options, { stack, reasons, status: 'failed', error: outcome.error });
        }
        const changed = outcome.classification.changed || outcome.changedOutputs.length > 0;
        return finish(options, {
          stack,
          reasons,
          status: changed ? 'changes' : 'no-changes',
          classification: outcome.classification,
          changedOutputs: outcome.changedOutputs,
          newStack: outcome.newStack,
          notes: outcome.notes,
        });
      },
    );

    // Failures first, so a stack never runs because one dependency changed while another failed
    for (const run of finished) {
      runs.set(run.stack.id, run);
      if (run.status === 'failed') {
        failed.add(run.stack.id);
        skipDependentsOf(run.stack.id);
      }
    }
    for (const run of finished) {
      if (run.status === 'failed' || !run.changedOutputs?.length) continue;
      for (const dependent of dependentsOf(options.graph, run.stack.id)) {
        if (runs.has(dependent)) continue;
        const reason = `${run.stack.id} outputs changed: ${run.changedOutputs.join(', ')}`;
        const failedDependency = dependsOnFailure(dependent);
        if (failedDependency) {
          const entry = pending.get(dependent);
          const stack = entry?.stack ?? byId.get(dependent);
          if (!stack) continue;
          const reasons = [...(entry?.reasons ?? []), reason];
          pending.delete(dependent);
          runs.set(
            dependent,
            finish(options, {
              stack,
              reasons,
              status: 'skipped',
              error: `${failedDependency} failed, and this stack depends on it${missedInputsNote(reasons)}`,
            }),
          );
          continue;
        }
        const entry = pending.get(dependent);
        if (entry) entry.reasons.push(reason);
        else if (byId.has(dependent)) {
          pending.set(dependent, { stack: byId.get(dependent) as Stack, reasons: [reason] });
        }
      }
    }
    if (stop) {
      for (const entry of pending.values()) {
        runs.set(
          entry.stack.id,
          finish(options, {
            ...entry,
            status: 'skipped',
            error: `an earlier stack failed${missedInputsNote(entry.reasons)}`,
          }),
        );
      }
      pending.clear();
    }
  }
  return [...runs.values()];
}

function finish(options: RunOptions, run: StackRun) {
  options.onFinish?.(run);
  return run;
}

/** Runs `task` on each item with at most `limit` running at once, keeping the input order */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
