import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { type Classification, type IgnoreRule, classify, parseFirstJson } from '../classify.ts';
import type { Stack } from '../projects.ts';

/*
 * Runs Pulumi for one stack through the repo's command template, so wrapper scripts that pick a
 * backend or credentials per stack keep working. Sign-in to Pulumi and the cloud happens before,
 * in the caller's own workflow steps.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PulumiRunner {
  /** Runs `<command template for stack> <args>` */
  run(stack: Stack, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult>;
  /** Runs `pulumi <args>` directly, for previews in a temporary backend */
  runPulumi(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
}

const MISSING_STACK = /no stack named '[^']*' found/i;

export interface RunnerOptions {
  /**
   * Pass the variables that let a step request a GitHub OIDC token. Off by default: with them,
   * the program could mint tokens that cloud trust policies accept for this workflow.
   */
  passOidc?: boolean;
}

/**
 * Variables the action runtime sets that a Pulumi program never needs: the job token passed as an
 * input, the runtime's own tokens, and the files whose contents become later steps' environment,
 * path and outputs.
 */
const PRIVATE_VARIABLES = [
  /^INPUT_/,
  /^ACTIONS_RUNTIME_/,
  /^ACTIONS_RESULTS_URL$/,
  /^ACTIONS_CACHE_URL$/,
  /^GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$/,
];
const OIDC_VARIABLES = /^ACTIONS_ID_TOKEN_REQUEST_/;

export function childEnvironment(
  options: RunnerOptions,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (PRIVATE_VARIABLES.some((pattern) => pattern.test(name))) continue;
    if (!options.passOidc && OIDC_VARIABLES.test(name)) continue;
    env[name] = value;
  }
  // Plain text: colour codes would end up in comments
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/** The stack, also as variables, so wrapper scripts can quote them safely: "$PULUMI_AFFECTED_STACK" */
function stackVariables(stack: Stack): NodeJS.ProcessEnv {
  return {
    PULUMI_AFFECTED_DIR: stack.dir === '' ? '.' : stack.dir,
    PULUMI_AFFECTED_STACK: stack.stack,
    PULUMI_AFFECTED_PROJECT: stack.project,
    PULUMI_AFFECTED_ID: stack.id,
  };
}

/*
 * Cancellation: GitHub stops a cancelled job with SIGINT, then SIGTERM. Pulumi needs SIGINT to
 * stop cleanly and release its stack lock, and files changed for a new-stack preview need
 * restoring, so both signals are forwarded and cleanup runs before exiting.
 */
const running = new Set<ChildProcess>();
const cleanups = new Set<() => void>();
let cancelling = false;
let handlersInstalled = false;
const CANCEL_GRACE = 25_000;

function installCancelHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const cancel = (signal: NodeJS.Signals) => {
    if (cancelling) return;
    cancelling = true;
    for (const child of running) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGINT');
      } catch {
        // Already gone
      }
    }
    const finish = () => {
      for (const cleanup of cleanups) cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    const deadline = Date.now() + CANCEL_GRACE;
    const wait = setInterval(() => {
      if (running.size === 0 || Date.now() > deadline) {
        clearInterval(wait);
        finish();
      }
    }, 200);
  };
  process.once('SIGINT', () => cancel('SIGINT'));
  process.once('SIGTERM', () => cancel('SIGTERM'));
}

/** Runs `cleanup` on cancellation too; returns a function that unregisters it */
function onCancel(cleanup: () => void) {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function commandRunner(
  template: string,
  repoRoot: string,
  options: RunnerOptions = {},
): PulumiRunner {
  installCancelHandlers();
  const exec = (command: string, env: NodeJS.ProcessEnv) =>
    new Promise<CommandResult>((resolve) => {
      if (cancelling) {
        resolve({ code: 130, stdout: '', stderr: 'cancelled' });
        return;
      }
      // Its own process group, so cancelling reaches Pulumi through any wrapper script
      const child = spawn('/bin/sh', ['-c', command], { cwd: repoRoot, env, detached: true });
      running.add(child);
      // Exit, not close: helpers it started (plugins) may hold its output open a while longer
      child.on('exit', () => running.delete(child));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on('error', (error) =>
        resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }),
      );
    });
  return {
    run: (stack, args, env = {}) =>
      exec(
        `${expandTemplate(template, stack)} ${args.map(quote).join(' ')}`,
        childEnvironment(options, { ...stackVariables(stack), ...env }),
      ),
    runPulumi: (args, env) =>
      exec(`pulumi ${args.map(quote).join(' ')}`, childEnvironment(options, env)),
  };
}

export function expandTemplate(template: string, stack: Stack) {
  const values: Record<string, string> = {
    dir: stack.dir === '' ? '.' : stack.dir,
    stack: stack.stack,
    project: stack.project,
    id: stack.id,
  };
  return template.replace(/\{(dir|stack|project|id)\}/g, (_, key: string) => quote(values[key]));
}

export function quote(value: string) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isMissingStack(result: CommandResult) {
  return result.code !== 0 && MISSING_STACK.test(result.stderr + result.stdout);
}

export type PreviewOutcome =
  | { kind: 'previewed'; classification: Classification; newStack: boolean }
  | { kind: 'failed'; error: string; newStack: boolean }
  | { kind: 'new-stack-skipped' };

export type NewStacks = 'preview' | 'skip';

export async function previewStack(
  runner: PulumiRunner,
  stack: Stack,
  repoRoot: string,
  ignore: readonly IgnoreRule[],
  newStacks: NewStacks = 'preview',
): Promise<PreviewOutcome> {
  // Asking for the outputs doesn't run the program, so its output can't pose as a missing stack
  const existence = await runner.run(stack, ['stack', 'output', '--json']);
  if (isMissingStack(existence)) {
    if (newStacks === 'skip') return { kind: 'new-stack-skipped' };
    return previewNewStack(runner, stack, repoRoot, ignore);
  }
  const result = await runner.run(stack, ['preview', '--json', '--non-interactive']);
  return toOutcome(result, ignore, false);
}

/**
 * A stack that doesn't exist yet is previewed in a temporary local backend, so nothing is
 * written to the real one before the change is merged. Pulumi writes an encryption salt into the
 * stack's config file when it creates the stack; the file is restored afterwards.
 */
async function previewNewStack(
  runner: PulumiRunner,
  stack: Stack,
  repoRoot: string,
  ignore: readonly IgnoreRule[],
): Promise<PreviewOutcome> {
  const backend = mkdtempSync(join(tmpdir(), 'pulumi-affected-backend-'));
  const configPath = join(repoRoot, stack.configFile);
  const originalConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const env: NodeJS.ProcessEnv = {
    PULUMI_BACKEND_URL: `file://${backend}`,
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
  };
  const cwd = stack.dir === '' ? '.' : stack.dir;
  const restore = () => {
    if (originalConfig === undefined) rmSync(configPath, { force: true });
    else writeFileSync(configPath, originalConfig);
    rmSync(backend, { recursive: true, force: true });
  };
  const unregister = onCancel(restore);
  try {
    const secretsProvider = readSecretsProvider(originalConfig);
    const init = await runner.runPulumi(
      [
        '--cwd',
        cwd,
        'stack',
        'init',
        stack.stack,
        '--non-interactive',
        ...(secretsProvider ? ['--secrets-provider', secretsProvider] : []),
      ],
      env,
    );
    if (init.code !== 0)
      return { kind: 'failed', error: newStackHint(errorText(init)), newStack: true };
    const result = await runner.runPulumi(
      ['--cwd', cwd, '--stack', stack.stack, 'preview', '--json', '--non-interactive'],
      env,
    );
    const outcome = toOutcome(result, ignore, true);
    return outcome.kind === 'failed' ? { ...outcome, error: newStackHint(outcome.error) } : outcome;
  } finally {
    unregister();
    restore();
  }
}

function newStackHint(error: string) {
  return `${error}\n\nThis stack doesn't exist yet, so it was previewed in a temporary local backend, where other stacks (StackReference), ESC environments and the real backend's secrets aren't available. Set run.newStacks to "skip" to leave new stacks out of previews.`;
}

function readSecretsProvider(config: string | undefined) {
  if (!config) return undefined;
  try {
    const value = (parseYaml(config) as { secretsprovider?: unknown } | null)?.secretsprovider;
    return typeof value === 'string' && value !== 'passphrase' ? value : undefined;
  } catch {
    return undefined;
  }
}

function toOutcome(
  result: CommandResult,
  ignore: readonly IgnoreRule[],
  newStack: boolean,
): PreviewOutcome {
  if (result.code !== 0) return { kind: 'failed', error: errorText(result), newStack };
  try {
    return { kind: 'previewed', classification: classify(result.stdout, ignore), newStack };
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
      newStack,
    };
  }
}

export type UpOutcome =
  | {
      kind: 'applied';
      classification: Classification;
      /** Output names whose values changed; values are never kept */
      changedOutputs: string[];
      newStack: boolean;
      /** Things the user should act on, e.g. a config file Pulumi changed that must be committed */
      notes: string[];
    }
  | { kind: 'failed'; error: string };

function isReadError(value: Outputs | { error: string }): value is { error: string } {
  return Object.keys(value).length === 1 && typeof value.error === 'string';
}

export async function upStack(
  runner: PulumiRunner,
  stack: Stack,
  repoRoot: string,
  ignore: readonly IgnoreRule[],
  createStacks = true,
): Promise<UpOutcome> {
  let newStack = false;
  const notes: string[] = [];
  let before = await readOutputs(runner, stack);
  if (before === 'missing') {
    const configPath = join(repoRoot, stack.configFile);
    const configBefore = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
    if (!createStacks) {
      return { kind: 'failed', error: "doesn't exist, and run.createStacks is false" };
    }
    if (wasCreatedBefore(configBefore)) {
      return {
        kind: 'failed',
        error: `doesn't exist in this backend, but ${stack.configFile} has an encryption salt or key from when it was created, so this is likely the wrong backend or organisation. Not creating it again.`,
      };
    }
    const secretsProvider = readSecretsProvider(configBefore);
    const init = await runner.run(stack, [
      'stack',
      'init',
      '--non-interactive',
      ...(secretsProvider ? ['--secrets-provider', secretsProvider] : []),
    ]);
    if (init.code !== 0) return { kind: 'failed', error: errorText(init) };
    const configAfter = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
    if (configAfter !== configBefore) {
      notes.push(
        `Pulumi wrote to ${stack.configFile} when creating the stack (usually an encryption salt); commit that change, or later runs can't read the stack's secrets`,
      );
    }
    newStack = true;
    before = {};
  }
  if (isReadError(before)) return { kind: 'failed', error: before.error };
  const outputsBefore = before as Outputs;

  const result = await runner.run(stack, ['up', '--yes', '--json', '--non-interactive']);
  if (result.code !== 0) return { kind: 'failed', error: errorText(result) };
  let classification: Classification;
  try {
    classification = classify(result.stdout, ignore);
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  const after = await readOutputs(runner, stack);
  const afterValues = after !== 'missing' && !isReadError(after) ? after : {};
  const keys = new Set([...Object.keys(outputsBefore), ...Object.keys(afterValues)]);
  const changedOutputs = [...keys]
    .filter((key) => !isDeepStrictEqual(outputsBefore[key], afterValues[key]))
    .sort();
  return { kind: 'applied', classification, changedOutputs, newStack, notes };
}

/** Stack outputs including secrets, compared in memory only and never printed */
type Outputs = Record<string, unknown>;

async function readOutputs(
  runner: PulumiRunner,
  stack: Stack,
): Promise<Outputs | 'missing' | { error: string }> {
  const result = await runner.run(stack, ['stack', 'output', '--json', '--show-secrets']);
  if (isMissingStack(result)) return 'missing';
  if (result.code !== 0) return { error: `couldn't read the stack outputs: ${errorText(result)}` };
  // A wrapper may print its own JSON first (e.g. the caller identity); outputs are the last object
  const parsed = parseLastJsonObject(result.stdout || '{}');
  return parsed && typeof parsed === 'object'
    ? (parsed as Outputs)
    : { error: "couldn't read the stack outputs: the output isn't JSON" };
}

/**
 * Creating a stack during a deploy is only safe when it's really new. A config file that already
 * has an encryption salt or key was created against some backend, so a missing stack then means
 * the job is pointed at the wrong backend or organisation, and creating it would duplicate every
 * resource.
 */
function wasCreatedBefore(config: string | undefined) {
  if (!config) return false;
  try {
    const parsed = parseYaml(config) as Record<string, unknown> | null;
    return Boolean(parsed && (parsed.encryptionsalt || parsed.encryptedkey));
  } catch {
    return false;
  }
}

/** The last top-level JSON object in output, after anything a wrapper printed */
function parseLastJsonObject(text: string) {
  const start = text.lastIndexOf('\n{');
  return parseFirstJson(start === -1 ? text : text.slice(start + 1));
}

export type DeployHistory =
  /**
   * Compare with this commit. `lastFailed` when a newer deploy failed after it; `dirty` when it
   * was deployed with uncommitted changes (Pulumi's own encryption salts count, so this is common
   * and only worth a warning)
   */
  | { kind: 'commit'; sha: string; lastFailed: boolean; dirty: boolean }
  /** No stack, no successful deploy, or destroyed since */
  | { kind: 'never' }
  /** Deployed, but not from a known commit; run it to be safe */
  | { kind: 'unknown'; why: string };

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 20;

/**
 * What a stack was last deployed from: Pulumi records `git.head` in each update's environment.
 * Refreshes are skipped. A deploy of only some resources (--target), or with no commit recorded,
 * doesn't say what's deployed, so it's unknown.
 */
export async function deployHistory(runner: PulumiRunner, stack: Stack): Promise<DeployHistory> {
  let lastFailed = false;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    const result = await runner.run(stack, [
      'stack',
      'history',
      '--json',
      '--page-size',
      String(HISTORY_PAGE_SIZE),
      '--page',
      String(page),
    ]);
    if (isMissingStack(result)) return { kind: 'never' };
    if (result.code !== 0) {
      throw new Error(`${stack.id}: can't read the stack history: ${errorText(result)}`);
    }
    const history = parseJsonArray(result.stdout);
    if (history === undefined) {
      throw new Error(`${stack.id}: the stack history isn't the JSON Pulumi prints`);
    }
    for (const update of history) {
      if (update.kind === 'destroy') {
        if (update.result === 'succeeded') return { kind: 'never' };
        return { kind: 'unknown', why: 'a destroy of it failed partway' };
      }
      // An import changes what's managed without a commit to compare with
      if (update.kind === 'import' && update.result === 'succeeded') {
        return { kind: 'unknown', why: 'resources were imported into it since its last deploy' };
      }
      if (update.kind !== 'update') continue;
      if (update.result !== 'succeeded') {
        lastFailed = true;
        continue;
      }
      const environment = update.environment ?? {};
      const head = environment['git.head'];
      // A deploy of only some resources leaves the rest as they were
      for (const flag of ['target', 'exclude', 'target-replace']) {
        const value = environment[`pulumi.flag.${flag}`];
        if (value && value !== 'false') {
          return {
            kind: 'unknown',
            why: `its last deploy only updated some resources (--${flag})`,
          };
        }
      }
      if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
        return { kind: 'unknown', why: "its last deploy didn't record a commit" };
      }
      return { kind: 'commit', sha: head, lastFailed, dirty: environment['git.dirty'] === 'true' };
    }
    // Pages can be smaller than asked for, so only an empty page ends the history
    if (history.length === 0) return { kind: 'never' };
  }
  return {
    kind: 'unknown',
    why: `no successful deploy in its last ${MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE} history entries`,
  };
}

interface HistoryEntry {
  kind?: string;
  result?: string;
  environment?: Record<string, string>;
}

/** The JSON array in output that a wrapper script may have printed other lines around */
function parseJsonArray(text: string): HistoryEntry[] | undefined {
  const start = text.indexOf('\n[') === -1 ? text.indexOf('[') : text.indexOf('\n[') + 1;
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) return text.trim() === '' ? [] : undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as HistoryEntry[];
  } catch {
    return undefined;
  }
}

/**
 * The useful part of a failed command's output, without the resource values the JSON output
 * carries: Pulumi's error diagnostics (from the preview document or the event stream), else
 * error lines and the last lines of stderr and of any non-JSON output.
 */
export function errorText(result: CommandResult) {
  const messages: string[] = [];
  const json = parseFirstJson(
    result.stdout,
    (value) => 'diagnostics' in value || 'steps' in value,
  ) as { diagnostics?: { message?: string; severity?: string }[] } | undefined;
  for (const diagnostic of json?.diagnostics ?? []) {
    if (diagnostic.severity === undefined || diagnostic.severity === 'error') {
      if (diagnostic.message?.trim()) messages.push(diagnostic.message.trim());
    }
  }
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{"sequence"')) continue;
    try {
      const event = JSON.parse(line) as {
        diagnosticEvent?: { message?: string; severity?: string };
      };
      const diagnostic = event.diagnosticEvent;
      if (diagnostic?.severity === 'error' && diagnostic.message?.trim()) {
        messages.push(diagnostic.message.trim());
      }
    } catch {
      // Not an event line
    }
  }
  if (messages.length > 0) return stripColour([...new Set(messages)].join('\n'));

  const plainOutput = json === undefined ? result.stdout : '';
  const lines = stripColour(`${result.stderr}\n${plainOutput}`).trim().split('\n');
  const errors = lines.filter((line) => /^\s*error:/i.test(line));
  return (errors.length > 0 ? errors : lines.slice(-20)).join('\n');
}

/** Terminal colour codes, raw or in the caret form some tools print */
const ESCAPE = String.fromCharCode(27);
const COLOUR_CODES = new RegExp(`(?:${ESCAPE}|\\^\\[)\\[[0-9;]*m`, 'g');

function stripColour(text: string) {
  return text.replace(COLOUR_CODES, '');
}
