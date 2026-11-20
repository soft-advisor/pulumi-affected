#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { classify } from './classify.ts';
import { ConfigError, defaultConfig, parseConfig } from './config.ts';
import { runCommand } from './run/index.ts';
import { renderStackDetails, renderTable, resultText, summaryLine } from './run/report.ts';
import { dependentsOf } from './graph.ts';
import { matchesStack } from './patterns.ts';
import { renderMarkdown } from './render.ts';
import { readDependencyGraph, select } from './select.ts';

/** classify's exit code when the preview changes nothing, so scripts can branch on it */
const NO_CHANGES_EXIT_CODE = 3;

const USAGE = `Usage:
  pulumi-affected select --base <rev> [--head <rev>] [--bases <file>] [--run <pattern>]...
                         [--skip <pattern>]... [--all] [--message <file>]...
                         [--format json|markdown] [--config <file>]
  pulumi-affected dependents <stack> [--transitive] [--head <rev>] [--config <file>]
  pulumi-affected classify [<file>]
  pulumi-affected run --mode preview|up --base <rev> [select options] [--command <template>]
                      [--concurrency <n>] [--fail-fast]

select    Prints the stacks a change affects, why, and the waves to run them in.
          --base      revision to compare against, e.g. the pull request's merge base
          --head      revision to analyse (default: the working tree)
          --bases     JSON file mapping stack ids to the revision each was last deployed
                      from (null: never deployed); those stacks compare against it
          --run       also select stacks matching a pattern ("all" selects every stack)
          --skip      leave out stacks matching a pattern, unless --run names them
          --message   file whose Pulumi-Affected-Run/Skip lines count, e.g. a PR description
dependents  Prints the stacks that depend on <stack>.
classify  Reads \`pulumi preview --json\` output (a file, or stdin) and prints whether it changes
          anything; exits 0 with changes, 3 without.
run       Selects stacks, then previews or deploys them in dependency order. Sign in to Pulumi
          and your cloud first. Up compares each stack with the commit it was last deployed from.

Stack patterns are "<project>/<stack>", where <project> is the project's name or folder, or a
bare "<stack>"; both parts may be globs.`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      bases: { type: 'string' },
      run: { type: 'string', multiple: true },
      skip: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      message: { type: 'string', multiple: true },
      format: { type: 'string', default: 'json' },
      config: { type: 'string' },
      transitive: { type: 'boolean' },
      mode: { type: 'string' },
      command: { type: 'string' },
      concurrency: { type: 'string' },
      'fail-fast': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }
  const config = values.config
    ? parseConfig(readFileSync(values.config, 'utf8'), values.config)
    : undefined;

  if (command === 'select') {
    if (!values.base) throw new UsageError('select needs --base');
    const result = select({
      cwd: process.cwd(),
      base: values.base,
      head: values.head,
      bases: values.bases ? JSON.parse(readFileSync(values.bases, 'utf8')) : undefined,
      run: values.run,
      skip: values.skip,
      all: values.all,
      messages: values.message?.map((path) => readFileSync(path, 'utf8')),
      config,
    });
    if (values.format === 'markdown') console.log(renderMarkdown(result));
    else console.log(JSON.stringify(result, null, 2));
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    return 0;
  }

  if (command === 'dependents') {
    const [pattern] = rest;
    if (!pattern) throw new UsageError('dependents needs a stack');
    const { stacks, graph } = readDependencyGraph({
      cwd: process.cwd(),
      head: values.head,
      config,
    });
    const matching = stacks.filter((stack) => matchesStack(pattern, stack));
    if (matching.length !== 1) {
      throw new UsageError(`"${pattern}" matches ${matching.length} stacks; name exactly one`);
    }
    console.log(JSON.stringify(dependentsOf(graph, matching[0].id, values.transitive), null, 2));
    return 0;
  }
  if (command === 'classify') {
    const [file] = rest;
    const text = readFileSync(file ?? 0, 'utf8');
    const result = classify(text, (config ?? defaultConfig()).classify.ignore);
    console.log(JSON.stringify(result, null, 2));
    return result.changed ? 0 : NO_CHANGES_EXIT_CODE;
  }

  if (command === 'run') {
    if (values.mode !== 'preview' && values.mode !== 'up')
      throw new UsageError('run needs --mode preview or --mode up');
    if (!values.base) throw new UsageError('run needs --base');
    const { runs } = await runCommand({
      cwd: process.cwd(),
      mode: values.mode,
      base: values.base,
      head: values.head,
      run: values.run,
      skip: values.skip,
      all: values.all,
      messages: values.message?.map((path) => readFileSync(path, 'utf8')),
      config,
      command: values.command,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      failFast: values['fail-fast'],
      onFinish: (run) => console.error(`${run.stack.id}: ${resultText(run) || run.status}`),
      onWarning: (message) => console.error(`warning: ${message}`),
    });
    if (values.format === 'markdown') {
      console.log(`### ${summaryLine(values.mode, runs)}\n\n${renderTable(runs)}`);
      for (const run of runs)
        if (run.status !== 'no-changes') console.log(`\n${renderStackDetails(run)}`);
    } else {
      console.log(JSON.stringify(runs, null, 2));
    }
    return runs.some((run) => run.status === 'failed') ? 1 : 0;
  }
  throw new UsageError(`unknown command "${command}"`);
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.error(`pulumi-affected: ${error.message}\n\n${USAGE}`);
    } else {
      console.error(`pulumi-affected: ${error instanceof Error ? error.message : error}`);
    }
    process.exitCode = 2;
  },
);
