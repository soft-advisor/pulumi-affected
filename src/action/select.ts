import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMarkdown } from '../render.ts';
import { select } from '../select.ts';
import { repoRootOf } from '../snapshot.ts';
import { splitPatterns } from '../patterns.ts';
import { eventContext } from './context.ts';
import {
  appendSummary,
  booleanInput,
  error,
  input,
  readEvent,
  setOutput,
  warning,
} from './github.ts';

/*
 * The `select` action: works out the comparison base from the triggering event, runs the
 * selection, and writes it as outputs, a JSON file for later jobs, and the job summary. It reads
 * files only; running Pulumi for the selected stacks is up to the workflow.
 */

function main() {
  const cwd = input('working-directory') || process.cwd();
  const repoRoot = repoRootOf(cwd);
  const event = readEvent();
  const context = eventContext(event, repoRoot);
  for (const message of context.warnings) warning(message);

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
    skip: splitPatterns(input('skip')),
    all: booleanInput('all') || context.all,
    messages: context.messages,
  });

  for (const message of result.warnings) warning(message);
  appendSummary(renderMarkdown(result));
  const json = JSON.stringify(result, null, 2);
  const outputFile = input('output-file');
  if (outputFile) writeFileSync(resolve(outputFile), `${json}\n`);
  setOutput('stacks', JSON.stringify(result.stacks));
  setOutput('ids', JSON.stringify(result.waves.flat()));
  setOutput('waves', JSON.stringify(result.waves));
  setOutput('any', result.stacks.length > 0 ? 'true' : 'false');
  setOutput('result', JSON.stringify(result));
  console.log(
    result.stacks.length === 0
      ? 'No stacks affected'
      : `Selected ${result.stacks.map((stack) => stack.id).join(', ')}`,
  );
}

try {
  main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
}
