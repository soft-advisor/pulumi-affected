import { loadConfig } from '../config.ts';
import type { OutputReaders } from '../plan/up.ts';
import type { SelectOptions } from '../select.ts';
import { splitPatterns } from '../patterns.ts';
import { type Context, eventContext } from './context.ts';
import { booleanInput, type GitHubEvent, input, readEvent, warning } from './github.ts';
import { repoRootOf, WorktreeSnapshot } from '../snapshot.ts';

/** Selection options from the action's inputs and the triggering event, shared by select and plan */
export function selectOptionsFromInputs(): { options: SelectOptions; event: GitHubEvent } {
  const cwd = input('working-directory') || process.cwd();
  const repoRoot = repoRootOf(cwd);
  const event = readEvent();
  // An explicit base replaces what the event would say, so the event isn't read at all: it may
  // belong to another repository, as when a workflow selects in a checkout of its own
  const context: Context = input('base')
    ? { base: undefined, messages: [], all: false, warnings: [] }
    : eventContext(event, repoRoot);
  for (const message of context.warnings) warning(message);

  const base = input('base') || context.base;
  if (!base && !booleanInput('all') && !context.all) {
    warning(
      `A ${event.name || 'local'} run has no revision to compare with, so only requested stacks are selected; set the base input`,
    );
  }
  return {
    event,
    options: {
      cwd,
      base: base || 'HEAD',
      head: input('head') || undefined,
      bases: input('bases') ? JSON.parse(input('bases')) : undefined,
      run: splitPatterns(input('run')),
      skip: splitPatterns(input('skip')),
      all: booleanInput('all') || context.all,
      messages: context.messages,
    },
  };
}

/** The pull request a run belongs to: the input, else the triggering pull request */
export function pullRequestNumber(event: GitHubEvent) {
  const explicit = input('pull-request');
  if (explicit) {
    const number = Number(explicit);
    if (!Number.isInteger(number) || number < 1)
      throw new Error(`pull-request "${explicit}" isn't a number`);
    return number;
  }
  const pullRequest = event.payload.pull_request as { number?: number } | undefined;
  return typeof pullRequest?.number === 'number' ? pullRequest.number : undefined;
}

export function positiveInteger(name: string, fallback: number) {
  const value = input(name);
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} "${value}" isn't a positive whole number`);
  return number;
}

/** An input that must be one of `values` */
export function choice<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = input(name) || fallback;
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be ${values.join(' or ')}, not "${value}"`);
  }
  return value as T;
}

/** The output-readers input, else the config's outputReaders, else up */
export function outputReaders(repoRoot: string): OutputReaders {
  if (input('output-readers')) return choice('output-readers', ['up', 'warn'] as const, 'up');
  return loadConfig(new WorktreeSnapshot(repoRoot)).outputReaders ?? 'up';
}
