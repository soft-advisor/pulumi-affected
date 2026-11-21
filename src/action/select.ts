import { renderMarkdown } from '../render.ts';
import { select } from '../select.ts';
import { repoRootOf } from '../snapshot.ts';
import { splitPatterns } from '../patterns.ts';
import { eventAllowsRun, eventContext, pullRequestContext } from './context.ts';
import {
  appendSummary,
  booleanInput,
  error,
  GitHubApi,
  input,
  notice,
  readEvent,
  setOutput,
  warning,
} from './github.ts';

/*
 * The `select` action: works out the comparison base from the triggering event, collects
 * Pulumi-Affected-Run/Skip lines and /pulumi-affected commands, runs the selection and writes
 * the outputs and job summary.
 */

async function main() {
  const cwd = input('working-directory') || process.cwd();
  const repoRoot = repoRootOf(cwd);
  const event = readEvent();
  const token = input('github-token');
  const api = token ? new GitHubApi(token) : undefined;

  const pullRequestNumber = Number(input('pull-request'));
  if (pullRequestNumber && !api)
    throw new Error('The pull-request input needs the github-token input');
  const context =
    pullRequestNumber && api
      ? (await eventAllowsRun(event, repoRoot, api))
        ? await pullRequestContext(api, repoRoot, pullRequestNumber)
        : undefined
      : await eventContext(event, repoRoot, api);
  for (const message of context?.warnings ?? []) warning(message);
  if (context === undefined) {
    notice('Not a /pulumi-affected command; nothing to select');
    writeOutputs([], [], '{}');
    return;
  }

  const base = input('base') || context.base;
  if (!base && !booleanInput('all') && !context.all) {
    warning(
      `A ${event.name || 'local'} run has no revision to compare with, so only requested stacks are selected; set the base input`,
    );
  }
  const result = select({
    cwd,
    base: base || 'HEAD',
    head: input('head') || undefined,
    bases: input('bases') ? JSON.parse(input('bases')) : undefined,
    run: splitPatterns(input('run')),
    requests: context.requests,
    skip: splitPatterns(input('skip')),
    all: booleanInput('all') || context.all,
    messages: context.messages,
  });

  for (const message of result.warnings) warning(message);
  appendSummary(renderMarkdown(result));
  writeOutputs(result.stacks, result.waves, JSON.stringify(result));
  console.log(
    result.stacks.length === 0
      ? 'No stacks affected'
      : `Selected ${result.stacks.map((stack) => stack.id).join(', ')}`,
  );
}

function writeOutputs(stacks: unknown[], waves: string[][], result: string) {
  setOutput('stacks', JSON.stringify(stacks));
  setOutput('ids', JSON.stringify(waves.flat()));
  setOutput('waves', JSON.stringify(waves));
  setOutput('any', stacks.length > 0 ? 'true' : 'false');
  setOutput('result', result);
}

main().catch((caught: unknown) => {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
});
