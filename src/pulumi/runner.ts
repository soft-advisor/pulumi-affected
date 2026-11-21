import { type ChildProcess, spawn } from 'node:child_process';
import { parseFirstJson } from '../classify.ts';

/*
 * Runs Pulumi for one stack through a command template, so wrapper scripts that pick a backend
 * or credentials per stack keep working. The template is split into words and run without a
 * shell; placeholders are filled in inside single arguments, so nothing in a stack's name or
 * folder can become a command. Sign-in to Pulumi and the cloud happens before, in the workflow.
 */

/** What the runner needs of a stack */
export interface StackTarget {
  id: string;
  project: string;
  dir: string;
  stack: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PulumiRunner {
  /** Runs `<command template for the stack> <args>` */
  run(stack: StackTarget, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult>;
  /** Runs `pulumi <args>` directly, for work in a temporary backend */
  runPulumi(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
}

export const DEFAULT_COMMAND = 'pulumi --cwd {dir} --stack {stack}';

const MISSING_STACK = /no stack named '[^']*' found/i;

/**
 * Variables the action runtime sets that a Pulumi program never needs: the job token passed as
 * an input, the runtime's own tokens, and the files whose contents become later steps'
 * environment, path and outputs. Leaving them out keeps them away from honest programs and out
 * of logs; it isn't isolation from a malicious one, which can read the parent process.
 */
const PRIVATE_VARIABLES = [
  /^INPUT_/,
  /^ACTIONS_RUNTIME_/,
  /^ACTIONS_RESULTS_URL$/,
  /^ACTIONS_CACHE_URL$/,
  /^GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$/,
];

export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!PRIVATE_VARIABLES.some((pattern) => pattern.test(name))) env[name] = value;
  }
  // Plain text: colour codes would end up in summaries and comments
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/** The stack, also as variables, for wrapper scripts */
function stackVariables(stack: StackTarget): NodeJS.ProcessEnv {
  return {
    PULUMI_AFFECTED_DIR: stack.dir === '' ? '.' : stack.dir,
    PULUMI_AFFECTED_STACK: stack.stack,
    PULUMI_AFFECTED_PROJECT: stack.project,
    PULUMI_AFFECTED_ID: stack.id,
  };
}

/** The template's words with placeholders filled in, each value staying one argument */
export function expandTemplate(template: string, stack: StackTarget) {
  const values: Record<string, string> = {
    dir: stack.dir === '' ? '.' : stack.dir,
    stack: stack.stack,
    project: stack.project,
    id: stack.id,
  };
  const words = template.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('The command template is empty');
  return words.map((word) =>
    word.replace(/\{(dir|stack|project|id)\}/g, (_, key: string) => values[key]),
  );
}

/*
 * Cancellation: GitHub stops a cancelled job with SIGINT, then SIGTERM. Pulumi needs SIGINT to
 * stop cleanly and release its stack lock, and files changed for a temporary-backend preview
 * need restoring, so both signals are forwarded and cleanup runs before exiting.
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
    const deadline = Date.now() + CANCEL_GRACE;
    const wait = setInterval(() => {
      if (running.size === 0 || Date.now() > deadline) {
        clearInterval(wait);
        for (const cleanup of cleanups) cleanup();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    }, 200);
  };
  process.once('SIGINT', () => cancel('SIGINT'));
  process.once('SIGTERM', () => cancel('SIGTERM'));
}

/** Runs `cleanup` on cancellation too; returns a function that unregisters it */
export function onCancel(cleanup: () => void) {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function commandRunner(template: string, repoRoot: string): PulumiRunner {
  installCancelHandlers();
  const exec = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<CommandResult>((resolve) => {
      if (cancelling) {
        resolve({ code: 130, stdout: '', stderr: 'cancelled' });
        return;
      }
      // Its own process group, so cancelling reaches Pulumi through any wrapper script
      const child = spawn(file, args, { cwd: repoRoot, env, detached: true });
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
    run: (stack, args, env = {}) => {
      const [file, ...words] = expandTemplate(template, stack);
      return exec(
        file,
        [...words, ...args],
        childEnvironment({ ...stackVariables(stack), ...env }),
      );
    },
    runPulumi: (args, env) => exec('pulumi', args, childEnvironment(env)),
  };
}

export function isMissingStack(result: CommandResult) {
  return result.code !== 0 && MISSING_STACK.test(result.stderr + result.stdout);
}

/**
 * The useful part of a failed command's output, without the resource values the JSON output
 * carries: Pulumi's error diagnostics, else error lines and the last lines of stderr and of any
 * non-JSON output.
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

/** The last top-level JSON object in output, after anything a wrapper printed */
export function parseLastJsonObject(text: string) {
  const start = text.lastIndexOf('\n{');
  return parseFirstJson(start === -1 ? text : text.slice(start + 1));
}

/** The JSON array in output that a wrapper script may have printed other lines around */
export function parseJsonArray<T>(text: string): T[] | undefined {
  const start = text.indexOf('\n[') === -1 ? text.indexOf('[') : text.indexOf('\n[') + 1;
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) return text.trim() === '' ? [] : undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T[];
  } catch {
    return undefined;
  }
}
