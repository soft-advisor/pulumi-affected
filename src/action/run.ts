import { renderMarkdown } from '../render.ts';
import { renderStackDetails, renderTable, splitComments, summaryLine } from '../run/report.ts';
import { runCommand } from '../run/index.ts';
import type { Mode, StackRun } from '../run/runner.ts';
import { splitPatterns } from '../patterns.ts';
import { repoRootOf } from '../snapshot.ts';
import { marker, syncComments } from './comments.ts';
import { eventContext, pullRequestContext } from './context.ts';
import {
  appendSummary,
  booleanInput,
  error,
  GitHubApi,
  input,
  notice,
  printUntrusted,
  readEvent,
  setOutput,
  warning,
} from './github.ts';

/*
 * The `run` action: selects stacks like `select`, then previews or deploys them in one job,
 * reports each stack in the job summary, and comments on the pull request: the preview on the
 * pull request itself, the deploy on the pull requests a push merged.
 */

async function main() {
  const mode = input('mode') as Mode;
  if (mode !== 'preview' && mode !== 'up') throw new Error('The mode input must be preview or up');
  const cwd = input('working-directory') || process.cwd();
  const repoRoot = repoRootOf(cwd);
  const event = readEvent();
  const token = input('github-token');
  const api = token ? new GitHubApi(token) : undefined;
  const runUrl = runLink();

  const pullRequestNumber = Number(input('pull-request'));
  if (pullRequestNumber && !api)
    throw new Error('The pull-request input needs the github-token input');
  const context =
    pullRequestNumber && api
      ? await pullRequestContext(api, repoRoot, pullRequestNumber)
      : await eventContext(event, repoRoot, api);
  for (const message of context?.warnings ?? []) warning(message);
  if (context === undefined) {
    notice('Not a /pulumi-affected command; nothing to run');
    writeOutputs([]);
    return;
  }

  const { selection, runs } = await runCommand({
    cwd,
    mode,
    base: input('base') || context.base || 'HEAD',
    head: input('head') || undefined,
    run: splitPatterns(input('run')),
    skip: splitPatterns(input('skip')),
    all: booleanInput('all') || context.all,
    messages: context.messages,
    requests: context.requests,
    command: input('command') || undefined,
    concurrency: input('concurrency') ? Number(input('concurrency')) : undefined,
    failFast: input('fail-fast') ? booleanInput('fail-fast') : undefined,
    passOidc: booleanInput('pass-oidc'),
    onFinish: printRun,
    onWarning: warning,
  });
  for (const message of selection.warnings) warning(message);

  const heading = `### ${summaryLine(mode, runs)}`;
  const sections = runs
    .filter((run) => run.status !== 'no-changes')
    .map((run) => renderStackDetails(run, undefined, runUrl));
  const intro = runs.length > 0 ? renderTable(runs) : 'No stacks affected.';
  appendSummary([heading, intro, ...sections].join('\n\n'));
  if (runs.length === 0) appendSummary(renderMarkdown(selection));

  if (api && booleanInput('comment')) {
    const footer = runUrl ? `\n\n<sub>[Run](${runUrl})</sub>` : '';
    try {
      if (mode === 'preview' && context.pullRequest) {
        const bodies = splitComments(heading, intro + footer, sections, (index) =>
          marker('preview', index),
        );
        // A push that selects nothing updates an earlier comment rather than adding one
        await syncComments(api, context.pullRequest.number, 'preview', bodies, runs.length === 0);
      }
      if (mode === 'up') {
        const sha = (process.env.GITHUB_SHA ?? 'head').slice(0, 12);
        for (const pullRequest of context.mergedPullRequests) {
          const bodies = splitComments(heading, intro + footer, sections, (index) =>
            marker(`deploy-${sha}`, index),
          );
          await syncComments(api, pullRequest.number, `deploy-${sha}`, bodies);
        }
      }
    } catch (error) {
      // Pull requests from forks get a read-only token; the job summary still has everything
      warning(`Couldn't comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  writeOutputs(runs);
  const failed = runs.filter((run) => run.status === 'failed');
  if (failed.length > 0) {
    throw new Error(`Failed: ${failed.map((run) => run.stack.id).join(', ')}`);
  }
}

function printRun(run: StackRun) {
  console.log(`::group::${escapeData(run.stack.id)}: ${run.status}`);
  const lines = [`Why: ${run.reasons.join('; ')}`];
  for (const change of run.classification?.changes ?? []) {
    lines.push(`  ${change.op} ${change.type} ${change.name} ${change.properties.join(', ')}`);
  }
  if (run.changedOutputs?.length) lines.push(`Outputs changed: ${run.changedOutputs.join(', ')}`);
  if (run.error) lines.push(run.error);
  printUntrusted(lines.join('\n'));
  console.log('::endgroup::');
  for (const note of run.notes ?? []) warning(`${run.stack.id}: ${note}`);
}

/** A group title can't contain a newline, or the rest would be read as commands */
function escapeData(text: string) {
  return text.replace(/[\r\n]/g, ' ');
}

function writeOutputs(runs: StackRun[]) {
  const ids = (status: StackRun['status']) =>
    JSON.stringify(runs.filter((run) => run.status === status).map((run) => run.stack.id));
  setOutput(
    'results',
    JSON.stringify(
      runs.map((run) => ({
        id: run.stack.id,
        status: run.status,
        reasons: run.reasons,
        counts: run.classification?.counts ?? {},
        changedOutputs: run.changedOutputs ?? [],
        newStack: run.newStack ?? false,
        error: run.error,
      })),
    ),
  );
  setOutput('changed', ids('changes'));
  setOutput('failed', ids('failed'));
  setOutput('any-changes', runs.some((run) => run.status === 'changes') ? 'true' : 'false');
}

function runLink() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

main().catch((caught: unknown) => {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
});
