import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyPlans } from '../plan/apply.ts';
import { MANIFEST_FILE } from '../plan/manifest.ts';
import { describeRead } from '../plan/outputs.ts';
import { renderApply } from '../plan/report.ts';
import { commandRunner, DEFAULT_COMMAND } from '../pulumi/runner.ts';
import { git, repoRootOf } from '../snapshot.ts';
import { marker, syncComments } from './comments.ts';
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
import { splitPatterns } from '../patterns.ts';
import { positiveInteger, pullRequestNumber } from './inputs.ts';

/*
 * The `apply` action's Node steps. `locate` works out where the plans come from: a directory
 * that already holds them, a given run's artifact, or the newest artifact for the checked-out
 * tree, which the composite action then downloads. `apply` applies them.
 */

const APPLY_COMMENT_FILE = 'apply-comment.md';

/** A run of this repository's own branches; a fork's run could upload any plans */
function isOwnRun(run: { repository_id?: number; head_repository_id?: number } | undefined) {
  return (
    typeof run?.repository_id === 'number' &&
    typeof run.head_repository_id === 'number' &&
    run.repository_id === run.head_repository_id
  );
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; repository_id: number; head_repository_id: number };
}

async function locate() {
  const repoRoot = repoRootOf(input('working-directory') || process.cwd());
  const tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  const name = `pulumi-plans-${tree}`;
  const directory = input('directory');
  if (directory && existsSync(join(resolve(directory), MANIFEST_FILE))) {
    setOutput('download', 'false');
    setOutput('directory', resolve(directory));
    return;
  }
  const target = resolve(directory || join(process.env.RUNNER_TEMP ?? '.', name));
  let runId = input('run-id');
  if (!runId) {
    const token = input('github-token');
    if (!token) throw new Error('No plans in directory and no github-token to find their artifact');
    const api = new GitHubApi(token);
    const { artifacts } = await api.request<{ artifacts: Artifact[] }>(
      'GET',
      api.repo(`/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`),
    );
    const usable = artifacts
      .filter(
        (artifact) =>
          artifact.name === name && !artifact.expired && isOwnRun(artifact.workflow_run),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (usable.length === 0) {
      throw new Error(
        `No artifact ${name}: plan this exact code first (the checkout's tree is ${tree})`,
      );
    }
    runId = String(usable[0].workflow_run?.id);
  } else {
    const token = input('github-token');
    if (!token) throw new Error('No github-token to check run-id');
    const api = new GitHubApi(token);
    const run = await api.request<{
      id: number;
      repository?: { id?: number };
      head_repository?: { id?: number };
    }>('GET', api.repo(`/actions/runs/${encodeURIComponent(runId)}`));
    if (
      !isOwnRun({ repository_id: run.repository?.id, head_repository_id: run.head_repository?.id })
    ) {
      throw new Error(`Run ${runId} isn't from this repository's own branches`);
    }
  }
  setOutput('download', 'true');
  setOutput('name', name);
  setOutput('run-id', runId);
  setOutput('directory', target);
}

async function apply() {
  const cwd = input('working-directory') || process.cwd();
  const directory = resolve(input('plans'));
  const result = await applyPlans({
    cwd,
    directory,
    runner: commandRunner(input('command') || DEFAULT_COMMAND, repoRootOf(cwd)),
    concurrency: positiveInteger('concurrency', 4),
    allow: input('stacks') ? splitPatterns(input('stacks')) : undefined,
    onFinish: (stack) => {
      if (stack.error) printUntrusted(`${stack.id}: ${stack.outcome}\n${stack.error}`);
      else console.log(`${stack.id}: ${stack.outcome}`);
    },
  });
  for (const message of result.warnings) warning(message);
  const report = renderApply(result, (index) => marker('apply', index));
  writeFileSync(join(directory, APPLY_COMMENT_FILE), report.bodies.join('\n\n'));
  appendSummary(report.summary);
  setOutput('directory', directory);
  setOutput(
    'result',
    JSON.stringify({
      stacks: result.stacks,
      needsPlan: result.needsPlan,
      followUps: result.followUps,
      warnings: result.warnings,
    }),
  );
  setOutput('needs-plan', JSON.stringify(result.needsPlan));
  setOutput('failed', result.ok ? 'false' : 'true');
  for (const read of result.followUps) {
    warning(`Plan ${read.id} again: it ${describeRead(read)}`);
  }

  if (booleanInput('comment')) {
    const token = input('github-token');
    const number =
      pullRequestNumber(readEvent()) ?? (token ? await mergedPullRequest(token, cwd) : undefined);
    if (number === undefined)
      notice('No pull request found for this commit, so the apply isn’t commented');
    else if (!token) warning('No github-token, so the apply isn’t commented');
    else {
      try {
        await syncComments(new GitHubApi(token), number, 'apply', report.bodies);
      } catch (caught) {
        warning(`Couldn't comment the apply: ${caught instanceof Error ? caught.message : caught}`);
      }
    }
  }
  if (!result.ok) error('Not every plan was applied');
}

/** The pull request a pushed commit came from */
async function mergedPullRequest(token: string, cwd: string) {
  const api = new GitHubApi(token);
  const sha = git(repoRootOf(cwd), ['rev-parse', 'HEAD']).trim();
  const pulls = await api.request<{ number: number; merged_at: string | null }[]>(
    'GET',
    api.repo(`/commits/${sha}/pulls`),
  );
  return pulls.find((pull) => pull.merged_at)?.number ?? pulls[0]?.number;
}

const step = process.argv[2] === 'locate' ? locate : apply;
step().catch((caught) => {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
});
