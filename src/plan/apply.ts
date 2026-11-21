import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import type { DependencyGraph } from '../graph.ts';
import { dependentsOf } from '../graph.ts';
import { errorText, type PulumiRunner } from '../pulumi/runner.ts';
import { latestUpdate, readOutputs, stateFingerprint } from '../pulumi/stack.ts';
import { readDependencyGraph } from '../select.ts';
import { git, repoRootOf } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import { initArgs } from './plan.ts';
import { type Manifest, type PlannedStack, readManifest } from './manifest.ts';

/*
 * Applies the plans `plan` wrote, exactly: `pulumi up --plan` for each, in dependency order, and
 * nothing is previewed again. Before each it checks the stack's state is still the one planned
 * from, since Pulumi itself only checks the plan against the program. Each update is tagged with
 * the plan's hash, so running apply again skips the plans that already went out.
 */

export interface ApplyOptions {
  /** Any folder inside the repository, checked out at the planned commit */
  cwd: string;
  /** The plan directory */
  directory: string;
  runner: PulumiRunner;
  concurrency: number;
  onFinish?: (result: StackApplyResult) => void;
}

export type ApplyOutcome =
  /** Applied now */
  | 'applied'
  /** An earlier run applied this plan */
  | 'already-applied'
  /** The stack's state changed since the plan; nothing was applied */
  | 'refused'
  | 'failed'
  /** A stack it depends on wasn't applied */
  | 'skipped';

export interface StackApplyResult {
  id: string;
  outcome: ApplyOutcome;
  error?: string;
  /** Stacks outside the plans that read this one's outputs, which changed */
  needsPlan?: string[];
}

export interface ApplyResult {
  manifest: Manifest;
  stacks: StackApplyResult[];
  /** Stacks that read outputs an apply changed and weren't planned with them */
  needsPlan: string[];
  ok: boolean;
}

export class ApplyError extends Error {}

export function updateMessage(stack: PlannedStack) {
  return `pulumi-affected:${stack.planHash}`;
}

export async function applyPlans(options: ApplyOptions): Promise<ApplyResult> {
  const repoRoot = repoRootOf(options.cwd);
  const directory = resolve(options.directory);
  const manifest = readManifest(directory);
  if (manifest.failed.length > 0) {
    throw new ApplyError(
      `Planning failed for ${manifest.failed.map((stack) => stack.id).join(', ')}; plan again before applying`,
    );
  }
  const tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  if (tree !== manifest.tree) {
    throw new ApplyError(
      `The plans are for tree ${manifest.tree}, but the checkout is ${tree}; check out the planned code or plan again`,
    );
  }
  // The manifest's stacks must be ones this code defines, in the folders it defines them in
  const { stacks: known } = readDependencyGraph({ cwd: repoRoot });
  // Pulumi itself writes encryption salts into stack config files, so those may differ
  const configFiles = new Set(known.map((stack) => stack.configFile));
  const modified = git(repoRoot, ['diff', '--name-only', '-z', 'HEAD'])
    .split('\0')
    .filter((path) => path && !configFiles.has(path));
  if (modified.length > 0) {
    throw new ApplyError(
      `The checkout has changes the plans weren't made from: ${modified.join(', ')}`,
    );
  }
  const byId = new Map(known.map((stack) => [stack.id, stack]));
  for (const stack of manifest.stacks) {
    const match = byId.get(stack.id);
    if (!match || match.dir !== stack.dir || match.stack !== stack.stack) {
      throw new ApplyError(`${stack.id} in the manifest isn't a stack this checkout defines`);
    }
  }

  const graph: DependencyGraph = new Map(
    Object.entries(manifest.dependencies).map(([id, deps]) => [id, new Set(deps)]),
  );
  const planned = new Set(manifest.stacks.map((stack) => stack.id));
  const results = new Map<string, StackApplyResult>();
  const waves = [...new Set(manifest.stacks.map((stack) => stack.wave))].sort((a, b) => a - b);
  for (const wave of waves) {
    const stacks = manifest.stacks.filter((stack) => stack.wave === wave);
    await mapConcurrently(stacks, options.concurrency, async (stack) => {
      const blocked = [...(graph.get(stack.id) ?? [])].filter((dependency) => {
        const result = results.get(dependency);
        return result && result.outcome !== 'applied' && result.outcome !== 'already-applied';
      });
      const result: StackApplyResult = blocked.length
        ? { id: stack.id, outcome: 'skipped', error: `not applied: ${blocked.join(', ')}` }
        : await applyStack(stack, {
            ...options,
            directory,
            configFile: byId.get(stack.id)?.configFile ?? '',
            repoRoot,
            dependents: dependentsOf(graph, stack.id).filter((id) => !planned.has(id)),
          });
      results.set(stack.id, result);
      options.onFinish?.(result);
    });
  }
  const stacks = manifest.stacks.map((stack) => results.get(stack.id) as StackApplyResult);
  return {
    manifest,
    stacks,
    needsPlan: [...new Set(stacks.flatMap((stack) => stack.needsPlan ?? []))].sort(),
    ok: stacks.every((stack) => stack.outcome === 'applied' || stack.outcome === 'already-applied'),
  };
}

interface StackContext extends ApplyOptions {
  directory: string;
  configFile: string;
  repoRoot: string;
  /** Unplanned stacks that read this one's outputs */
  dependents: string[];
}

async function applyStack(stack: PlannedStack, context: StackContext): Promise<StackApplyResult> {
  const { runner } = context;
  const message = updateMessage(stack);
  const fail = (error: string): StackApplyResult => ({ id: stack.id, outcome: 'failed', error });
  try {
    const current = await stateFingerprint(runner, stack);
    if (current.kind === 'exists' && (await appliedBefore(stack, runner, message))) {
      // An earlier run applied this plan; one without changes leaves the state as planned
      return { id: stack.id, outcome: 'already-applied' };
    }
    if (stack.state.kind === 'exists') {
      if (current.kind === 'missing') return fail('the stack no longer exists');
      if (current.fingerprint !== stack.state.fingerprint) return refused(stack);
    } else if (current.kind === 'exists') {
      // Created since planning, by someone else
      return refused(stack);
    } else {
      const init = await runner.run(stack, initArgs(context.repoRoot, context.configFile));
      if (init.code !== 0) return fail(`couldn't create the stack: ${errorText(init)}`);
    }

    const before = context.dependents.length > 0 ? await readOutputs(runner, stack) : undefined;
    const planPath = join(context.directory, stack.plan);
    const up = await runner.run(stack, [
      'up',
      '--yes',
      '--non-interactive',
      '--skip-preview',
      '--plan',
      planPath,
      '--message',
      message,
    ]);
    if (up.code !== 0) return fail(errorText(up));
    if (before === undefined) return { id: stack.id, outcome: 'applied' };
    const after = await readOutputs(runner, stack);
    return {
      id: stack.id,
      outcome: 'applied',
      needsPlan: isDeepStrictEqual(before, after) ? undefined : context.dependents,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Whether the stack's latest update applied this plan */
async function appliedBefore(stack: PlannedStack, runner: PulumiRunner, message: string) {
  const latest = await latestUpdate(runner, stack);
  return latest?.message === message && latest.result === 'succeeded';
}

function refused(stack: PlannedStack): StackApplyResult {
  return {
    id: stack.id,
    outcome: 'refused',
    error: "the stack's state changed since it was planned; plan it again",
  };
}
