import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMarkdown } from '../render.ts';
import { select } from '../select.ts';
import { appendSummary, error, input, setOutput, warning } from './github.ts';
import { selectOptionsFromInputs } from './inputs.ts';

/*
 * The `select` action: works out the comparison base from the triggering event, runs the
 * selection, and writes it as outputs, a JSON file for later jobs, and the job summary. It reads
 * files only; running Pulumi for the selected stacks is up to the workflow.
 */

function main() {
  const { options } = selectOptionsFromInputs();
  const result = select(options);

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
