import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Classification, classify, type IgnoreRule } from '../classify.ts';
import { loadConfig } from '../config.ts';
import { type DependencyGraph, dependentsOf } from '../graph.ts';
import { errorText, onCancel, type PulumiRunner } from '../pulumi/runner.ts';
import { secretsProviderOf, stateFingerprint } from '../pulumi/stack.ts';
import { type SelectedStack, type SelectOptions, select } from '../select.ts';
import { git, repoRootOf, WorktreeSnapshot } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import {
  hashFile,
  type Manifest,
  type PlannedStack,
  planFileNames,
  writeManifest,
} from './manifest.ts';

/*
 * Plans the stacks a change affects: selects them, previews each with --save-plan, keeps the
 * plans that would change something, and writes them with a manifest for `apply`. A stack that
 * doesn't exist yet is created empty first, or, with createStacks: 'apply', previewed in a
 * temporary local backend and created when its plan is applied.
 */

export type CreateStacks = 'plan' | 'apply';

export interface PlanOptions {
  select: Omit<SelectOptions, 'head'>;
  /** Where to write plans, previews and the manifest */
  directory: string;
  runner: PulumiRunner;
  concurrency: number;
  createStacks: CreateStacks;
  onFinish?: (outcome: StackOutcome) => void;
}

export type StackOutcome =
  | { kind: 'planned'; stack: PlannedStack }
  | { kind: 'unchanged'; id: string; reasons: string[] }
  | { kind: 'failed'; id: string; error: string; reasons: string[] };

export async function planStacks(options: PlanOptions): Promise<Manifest> {
  const repoRoot = repoRootOf(options.select.cwd);
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const config = options.select.config ?? loadConfig(new WorktreeSnapshot(repoRoot));
  const selection = select({ ...options.select, config });
  const graph: DependencyGraph = new Map(
    Object.entries(selection.dependencies).map(([id, deps]) => [id, new Set(deps)]),
  );

  const outcomes = await mapConcurrently(selection.stacks, options.concurrency, async (stack) => {
    const outcome = await planStack(stack, {
      ...options,
      directory,
      repoRoot,
      ignore: config.classify.ignore,
      hasDependents: dependentsOf(graph, stack.id).length > 0,
    });
    options.onFinish?.(outcome);
    return outcome;
  });

  const manifest: Manifest = {
    version: 1,
    tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim(),
    head: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    base: selection.base,
    pulumiVersion: await pulumiVersion(options.runner),
    stacks: outcomes.flatMap((outcome) => (outcome.kind === 'planned' ? [outcome.stack] : [])),
    unchanged: outcomes.flatMap((outcome) =>
      outcome.kind === 'unchanged' ? [{ id: outcome.id, reasons: outcome.reasons }] : [],
    ),
    failed: outcomes.flatMap((outcome) =>
      outcome.kind === 'failed'
        ? [{ id: outcome.id, error: outcome.error, reasons: outcome.reasons }]
        : [],
    ),
    skipped: selection.skipped,
    dependencies: selection.dependencies,
    warnings: selection.warnings,
  };
  writeManifest(directory, manifest);
  return manifest;
}

interface StackContext extends PlanOptions {
  directory: string;
  repoRoot: string;
  ignore: readonly IgnoreRule[];
  hasDependents: boolean;
}

async function planStack(stack: SelectedStack, context: StackContext): Promise<StackOutcome> {
  const files = planFileNames(stack.id);
  const planPath = join(context.directory, files.plan);
  const previewPath = join(context.directory, files.preview);
  const fail = (error: string): StackOutcome => {
    rmSync(planPath, { force: true });
    rmSync(previewPath, { force: true });
    return { kind: 'failed', id: stack.id, error, reasons: stack.reasons };
  };

  let state: PlannedStack['state'];
  let created = false;
  let preview: { code: number; stdout: string; stderr: string };
  try {
    const current = await stateFingerprint(context.runner, stack);
    if (current.kind === 'exists') {
      state = current;
      preview = await context.runner.run(stack, previewArgs(planPath));
    } else if (context.createStacks === 'plan') {
      const init = await context.runner.run(stack, initArgs(context.repoRoot, stack.configFile));
      if (init.code !== 0) return fail(`couldn't create the stack: ${errorText(init)}`);
      created = true;
      const fresh = await stateFingerprint(context.runner, stack);
      if (fresh.kind !== 'exists') return fail("the stack still doesn't exist after creating it");
      state = fresh;
      preview = await context.runner.run(stack, previewArgs(planPath));
    } else {
      state = { kind: 'created-on-apply' };
      preview = await previewInTemporaryBackend(context, stack, planPath);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (preview.code !== 0) return fail(errorText(preview));
  writeFileSync(previewPath, preview.stdout);

  let classification: Classification;
  try {
    classification = classify(preview.stdout, context.ignore);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // A new stack always has something to apply: creating it. A stack others read keeps its plan,
  // since a preview usually can't tell whether its outputs change.
  const isNew = state.kind === 'created-on-apply' || created;
  const keptForDependents = !classification.changed && !isNew && context.hasDependents;
  if (!classification.changed && !isNew && !keptForDependents) {
    rmSync(planPath, { force: true });
    rmSync(previewPath, { force: true });
    return { kind: 'unchanged', id: stack.id, reasons: stack.reasons };
  }
  if (!existsSync(planPath)) return fail('Pulumi wrote no plan file');
  return {
    kind: 'planned',
    stack: {
      id: stack.id,
      project: stack.project,
      dir: stack.dir,
      stack: stack.stack,
      wave: stack.wave,
      state,
      created,
      plan: files.plan,
      preview: files.preview,
      planHash: hashFile(planPath),
      counts: classification.counts,
      changes: classification.changes,
      keptForDependents,
      reasons: stack.reasons,
    },
  };
}

function previewArgs(planPath: string) {
  return ['preview', '--json', '--non-interactive', '--save-plan', planPath];
}

/** `stack init`, with the secrets provider the stack's config file names */
export function initArgs(repoRoot: string, configFile: string) {
  const path = join(repoRoot, configFile);
  const provider = secretsProviderOf(existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  return [
    'stack',
    'init',
    '--non-interactive',
    ...(provider ? ['--secrets-provider', provider] : []),
  ];
}

/**
 * Previews a stack that doesn't exist yet in a temporary local backend, so nothing is written to
 * the real one before its plan is applied. Pulumi writes an encryption salt into the stack's
 * config file when it creates the stack there; the file is restored afterwards. This runs plain
 * `pulumi`, not the command template, since a wrapper may pick the real backend itself.
 */
async function previewInTemporaryBackend(
  context: StackContext,
  stack: SelectedStack,
  planPath: string,
) {
  const backend = mkdtempSync(join(tmpdir(), 'pulumi-affected-backend-'));
  const configPath = join(context.repoRoot, stack.configFile);
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const restore = () => {
    if (original === undefined) rmSync(configPath, { force: true });
    else writeFileSync(configPath, original);
    rmSync(backend, { recursive: true, force: true });
  };
  const unregister = onCancel(restore);
  const env: NodeJS.ProcessEnv = {
    PULUMI_BACKEND_URL: `file://${backend}`,
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
  };
  const cwd = stack.dir === '' ? '.' : stack.dir;
  try {
    const init = await context.runner.runPulumi(
      ['--cwd', cwd, '--stack', stack.stack, ...initArgs(context.repoRoot, stack.configFile)],
      env,
    );
    if (init.code !== 0) return init;
    return await context.runner.runPulumi(
      ['--cwd', cwd, '--stack', stack.stack, ...previewArgs(planPath)],
      env,
    );
  } finally {
    unregister();
    restore();
  }
}

async function pulumiVersion(runner: PulumiRunner) {
  const result = await runner.runPulumi(['version'], {});
  return result.code === 0 ? result.stdout.trim() : 'unknown';
}
