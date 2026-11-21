import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { IgnoreRule } from '../classify.ts';
import { loadConfig } from '../config.ts';
import { CycleError, computeWaves, type DependencyGraph } from '../graph.ts';
import { matchesAnyStack } from '../patterns.ts';
import { errorText, onCancel, type PulumiRunner } from '../pulumi/runner.ts';
import { recentUpdates, stateFingerprint } from '../pulumi/stack.ts';
import { readDependencyGraph } from '../select.ts';
import { GitSnapshot, git, repoRootOf, resolveCommit } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import { hashText, type Manifest, type PlannedStack, readManifest } from './manifest.ts';
import { encryptionSaltOf, pulumiVersion } from './plan.ts';
import { describeRead, type StaleRead, staleReads } from './outputs.ts';
import { relaxPlan } from './planfile.ts';

/*
 * Applies the plans `plan` wrote, exactly: `pulumi up --plan` for each, in dependency order, and
 * nothing is previewed again. The plans came from a job that ran the pull request's code, so
 * everything else comes from the checked-out commit: which stacks exist, their order, the config.
 * Before each stack it checks the state is still the one planned from, since Pulumi itself only
 * checks the plan against the program. Each update is tagged with the plan's hash, so running
 * apply again skips the plans that already went out.
 */

export interface ApplyOptions {
  /** Any folder inside the repository, checked out at the planned commit */
  cwd: string;
  /** The plan directory */
  directory: string;
  runner: PulumiRunner;
  concurrency: number;
  /** Stack patterns that may be applied; a plan for any other stack is refused */
  allow?: string[];
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
  /** A stack it depends on wasn't applied, or changes outputs this plan was made without */
  | 'skipped';

export interface StackApplyResult {
  id: string;
  outcome: ApplyOutcome;
  error?: string;
  /** Plan properties left open by ignore rules, as "<URN> <property>" */
  relaxed?: string[];
}

export interface ApplyResult {
  manifest: Manifest;
  stacks: StackApplyResult[];
  /** Stacks that read outputs the applied plans change, and need planning again */
  needsPlan: string[];
  /** The same, with the outputs each reads */
  followUps: StaleRead[];
  warnings: string[];
  ok: boolean;
}

export class ApplyError extends Error {}

export function updateMessage(stack: PlannedStack) {
  return `pulumi-affected:${stack.planHash}`;
}

const DONE = new Set<ApplyOutcome>(['applied', 'already-applied']);

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

  // Stacks, their order and the config come from the commit, never from files beside it
  const commit = resolveCommit(repoRoot, 'HEAD');
  const config = loadConfig(new GitSnapshot(repoRoot, commit));
  const {
    stacks: known,
    graph,
    outputsRead,
  } = readDependencyGraph({ cwd: repoRoot, head: commit, config });
  checkCheckout(repoRoot, directory, known);
  const byId = new Map(known.map((stack) => [stack.id, stack]));
  for (const stack of manifest.stacks) {
    const match = byId.get(stack.id);
    if (!match || match.dir !== stack.dir || match.stack !== stack.stack) {
      throw new ApplyError(`${stack.id} in the manifest isn't a stack this commit defines`);
    }
    if (options.allow && !matchesAnyStack(options.allow, match)) {
      throw new ApplyError(`${stack.id} has a plan but isn't one of the stacks allowed to apply`);
    }
  }

  const warnings: string[] = [];
  const version = await pulumiVersion(options.runner);
  if (version !== manifest.pulumiVersion) {
    warnings.push(`Planned with Pulumi ${manifest.pulumiVersion}, applying with ${version}`);
  }

  const planned = new Map(manifest.stacks.map((stack) => [stack.id, stack]));
  const stale = staleReads(
    manifest.stacks,
    Object.fromEntries([...graph].map(([id, dependencies]) => [id, [...dependencies]])),
    outputsRead,
  );
  const results = new Map<string, StackApplyResult>();
  for (const wave of applyWaves(graph, [...planned.keys()])) {
    const stacks = wave.map((id) => planned.get(id) as PlannedStack);
    await mapConcurrently(stacks, options.concurrency, async (stack) => {
      const result =
        blockedBy(stack, graph, planned, stale, results) ??
        (await applyStack(stack, {
          ...options,
          directory,
          repoRoot,
          configFile: byId.get(stack.id)?.configFile ?? '',
          ignore: config.classify.ignore,
        }));
      results.set(stack.id, result);
      options.onFinish?.(result);
    });
  }

  const stacks = manifest.stacks.map((stack) => results.get(stack.id) as StackApplyResult);
  const applied = (id: string) => DONE.has(results.get(id)?.outcome ?? 'failed');
  // A stack reading outputs that an applied plan changed was planned (or deployed) without them
  const followUps = stale.filter((read) => applied(read.dependency) && !applied(read.id));
  return {
    manifest,
    stacks,
    needsPlan: [...new Set(followUps.map((read) => read.id))].sort(),
    followUps,
    warnings,
    ok: stacks.every((stack) => DONE.has(stack.outcome)),
  };
}

/** Waves of the planned stacks by the commit's dependencies; one stack at a time if they cycle */
function applyWaves(graph: DependencyGraph, ids: string[]) {
  try {
    return computeWaves(graph, ids);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
    return [...ids].sort().map((id) => [id]);
  }
}

/** Why a stack can't apply because of a planned stack it depends on */
function blockedBy(
  stack: PlannedStack,
  graph: DependencyGraph,
  planned: Map<string, PlannedStack>,
  stale: StaleRead[],
  results: Map<string, StackApplyResult>,
): StackApplyResult | undefined {
  const dependencies = [...(graph.get(stack.id) ?? [])].filter((id) => planned.has(id));
  const notApplied = dependencies.filter((id) => !DONE.has(results.get(id)?.outcome ?? 'failed'));
  if (notApplied.length > 0) {
    return { id: stack.id, outcome: 'skipped', error: `not applied: ${notApplied.join(', ')}` };
  }
  // Its plan was made with outputs that have changed since; `plan` doesn't keep such plans
  const reads = stale.filter((read) => read.id === stack.id);
  if (reads.length > 0) {
    return {
      id: stack.id,
      outcome: 'skipped',
      error: `plan it again: it ${reads.map(describeRead).join('; ')}`,
    };
  }
  return undefined;
}

/**
 * The checkout must be the commit: nothing modified or added, except the plan directory and the
 * encryption salts Pulumi writes into stack config files
 */
function checkCheckout(repoRoot: string, directory: string, known: { configFile: string }[]) {
  const planFolder = relative(repoRoot, directory);
  const insidePlans = (path: string) =>
    planFolder !== '' &&
    !planFolder.startsWith('..') &&
    !isAbsolute(planFolder) &&
    (path === planFolder || path.startsWith(`${planFolder}/`));
  const configFiles = new Set(known.map((stack) => stack.configFile));
  const split = (text: string) => text.split('\0').filter(Boolean);
  const changed = [
    ...split(git(repoRoot, ['diff', '--name-only', '-z', 'HEAD'])),
    ...split(git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ].filter(
    (path) => !insidePlans(path) && !(configFiles.has(path) && onlySaltChanged(repoRoot, path)),
  );
  if (changed.length > 0) {
    throw new ApplyError(
      `The checkout has files the commit doesn't: ${changed.join(', ')}; apply from a clean checkout`,
    );
  }
}

/** Whether a config file differs from the commit's only in its encryption salt */
function onlySaltChanged(repoRoot: string, path: string) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) return false;
  let committed = '';
  try {
    committed = git(repoRoot, ['show', `HEAD:${path}`]);
  } catch {
    // Added since the commit
  }
  const withoutSalt = (text: string) => {
    const { encryptionsalt: _, ...rest } = (parseYaml(text) ?? {}) as Record<string, unknown>;
    return rest;
  };
  try {
    return isDeepStrictEqual(withoutSalt(committed), withoutSalt(readFileSync(full, 'utf8')));
  } catch {
    return false;
  }
}

interface StackContext extends ApplyOptions {
  directory: string;
  repoRoot: string;
  configFile: string;
  ignore: readonly IgnoreRule[];
}

async function applyStack(stack: PlannedStack, context: StackContext): Promise<StackApplyResult> {
  const { runner } = context;
  const message = updateMessage(stack);
  const fail = (error: string): StackApplyResult => ({ id: stack.id, outcome: 'failed', error });
  try {
    const current = await stateFingerprint(runner, stack);
    if (current.kind === 'missing') return fail('the stack no longer exists');
    if (await appliedBefore(stack, runner, message)) {
      return { id: stack.id, outcome: 'already-applied' };
    }
    if (current.fingerprint !== stack.fingerprint) {
      return {
        id: stack.id,
        outcome: 'refused',
        error: "the stack's state changed since it was planned; plan it again",
      };
    }
    restoreSalt(stack, join(context.repoRoot, context.configFile));

    // Checked again here: programs and wrappers that ran earlier in this job could change files
    const text = readFileSync(join(context.directory, stack.plan));
    if (hashText(text) !== stack.planHash)
      return fail(`${stack.plan} changed since it was checked`);
    const { text: plan, relaxed } = relaxPlan(text.toString('utf8'), context.ignore);
    const folder = mkdtempSync(join(tmpdir(), 'pulumi-affected-apply-'));
    const cleanup = () => rmSync(folder, { recursive: true, force: true });
    const unregister = onCancel(cleanup);
    try {
      const planPath = join(folder, 'plan.json');
      writeFileSync(planPath, plan);
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
      if (up.code !== 0) return { ...fail(errorText(up)), relaxed };
      return { id: stack.id, outcome: 'applied', relaxed };
    } finally {
      unregister();
      cleanup();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Whether an update in the stack's recent history applied this plan */
async function appliedBefore(stack: PlannedStack, runner: PulumiRunner, message: string) {
  const updates = await recentUpdates(runner, stack);
  return updates.some((update) => update.message === message && update.result === 'succeeded');
}

/**
 * Puts back the encryption salt of a stack `plan` created, which its plan's secrets are encrypted
 * with, when the checkout's config file doesn't have one
 */
function restoreSalt(stack: PlannedStack, configPath: string) {
  if (!stack.encryptionSalt || encryptionSaltOf(configPath) !== undefined) return;
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(configPath, `${separator}encryptionsalt: ${stack.encryptionSalt}\n`);
}
