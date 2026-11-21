import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Classification, classify, type IgnoreRule } from '../classify.ts';
import { loadConfig } from '../config.ts';
import { errorText, type PulumiRunner } from '../pulumi/runner.ts';
import { secretsProviderOf, stateFingerprint } from '../pulumi/stack.ts';
import { type SelectedStack, type SelectOptions, select } from '../select.ts';
import { git, repoRootOf, WorktreeSnapshot } from '../snapshot.ts';
import { mapConcurrently } from './concurrency.ts';
import { stackOutputChanges } from './planfile.ts';
import {
  hashFile,
  type Manifest,
  type PlannedStack,
  planFileNames,
  writeManifest,
} from './manifest.ts';

/*
 * Plans the stacks a change affects: selects them, previews each with --save-plan, keeps the
 * plans that would change a resource or a stack output, and writes them with a manifest for
 * `apply`. A stack that doesn't exist yet is created, empty, first: Pulumi can only plan for a
 * stack that exists, with the stacks it references and its secrets provider.
 */

export interface PlanOptions {
  select: Omit<SelectOptions, 'head'>;
  /** Where to write plans, previews and the manifest */
  directory: string;
  runner: PulumiRunner;
  concurrency: number;
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

  const outcomes = await mapConcurrently(selection.stacks, options.concurrency, async (stack) => {
    const outcome = await planStack(stack, {
      ...options,
      directory,
      repoRoot,
      ignore: config.classify.ignore,
    });
    options.onFinish?.(outcome);
    return outcome;
  });

  const manifest: Manifest = {
    version: 2,
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

  let fingerprint: string;
  let created = false;
  let preview: { code: number; stdout: string; stderr: string };
  try {
    let current = await stateFingerprint(context.runner, stack);
    if (current.kind === 'missing') {
      const init = await context.runner.run(stack, initArgs(context.repoRoot, stack.configFile));
      if (init.code !== 0) return fail(`couldn't create the stack: ${errorText(init)}`);
      created = true;
      current = await stateFingerprint(context.runner, stack);
      if (current.kind !== 'exists') return fail("the stack still doesn't exist after creating it");
    }
    fingerprint = current.fingerprint;
    preview = await context.runner.run(stack, previewArgs(planPath));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (preview.code !== 0) return fail(errorText(preview));
  writeFileSync(previewPath, preview.stdout);

  let classification: Classification;
  let outputs: string[];
  try {
    classification = classify(preview.stdout, context.ignore);
    if (!existsSync(planPath)) return fail('Pulumi wrote no plan file');
    // The preview doesn't show stack outputs that would change; the plan does
    outputs = stackOutputChanges(readFileSync(planPath, 'utf8'));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // A new stack always has something to apply: creating it
  if (!classification.changed && outputs.length === 0 && !created) {
    rmSync(planPath, { force: true });
    rmSync(previewPath, { force: true });
    return { kind: 'unchanged', id: stack.id, reasons: stack.reasons };
  }
  return {
    kind: 'planned',
    stack: {
      id: stack.id,
      project: stack.project,
      dir: stack.dir,
      stack: stack.stack,
      wave: stack.wave,
      fingerprint,
      created,
      encryptionSalt: created
        ? encryptionSaltOf(join(context.repoRoot, stack.configFile))
        : undefined,
      plan: files.plan,
      preview: files.preview,
      planHash: hashFile(planPath),
      counts: classification.counts,
      changes: classification.changes,
      outputs,
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

/** The `encryptionsalt` in a stack's config file, if any */
export function encryptionSaltOf(path: string) {
  if (!existsSync(path)) return undefined;
  try {
    const salt = (parseYaml(readFileSync(path, 'utf8')) as { encryptionsalt?: unknown } | null)
      ?.encryptionsalt;
    return typeof salt === 'string' ? salt : undefined;
  } catch {
    return undefined;
  }
}

export async function pulumiVersion(runner: PulumiRunner) {
  const result = await runner.runPulumi(['version'], {});
  return result.code === 0 ? result.stdout.trim() : 'unknown';
}
