import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * Drives the end-to-end test of one scenario in this repository, as the e2e workflow's steps:
 *
 *   prepare  copies e2e/fixtures into a repository of its own, deploys every stack, pushes it as
 *            a throwaway base branch, pushes the scenario's change as a second branch, and opens
 *            a draft pull request between them
 *   assert-preview / assert-deploy  check what the run action did, and its comments
 *   merge    squash-merges the pull request and checks out the result
 *   cleanup  closes the pull request and deletes both branches
 *
 * Pull requests opened with GITHUB_TOKEN don't trigger workflows, so the workflow calls the run
 * action itself, naming the pull request with the `pull-request` input.
 */

interface Scenario {
  name: string;
  changes: Record<string, string | null>;
  body?: string;
  expected: string[];
  deployed: string[];
}

const E2E = import.meta.dirname;
const TOOL = join(E2E, '..');
const scenarios: Scenario[] = JSON.parse(readFileSync(join(E2E, 'scenarios.json'), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY ?? '';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function sh(cwd: string, command: string, args: string[], input?: string) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: command === 'git' ? { ...process.env, ...gitAuth() } : process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

/**
 * Authenticates git through environment-only config, so the token never appears in a command
 * line (which error messages repeat)
 */
function gitAuth(): NodeJS.ProcessEnv {
  const token = process.env.GH_TOKEN;
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Runs a GitHub-facing command again after a short wait when GitHub has a transient failure */
function retried(cwd: string, command: string, args: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return sh(cwd, command, args);
    } catch (error) {
      if (attempt === 3) throw error;
      console.log(`Attempt ${attempt} of ${command} ${args[0]} failed; retrying`);
      execFileSync('sleep', [String(attempt * 5)]);
    }
  }
}

function output(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function remote() {
  required('GITHUB_REPOSITORY');
  required('GH_TOKEN');
  return `https://github.com/${repository}.git`;
}

function branches(index: number) {
  const prefix = `e2e-runs/${required('RUN_KEY')}/${index}`;
  return { base: `${prefix}/base`, change: `${prefix}/change` };
}

function commitAll(dir: string, message: string) {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '--allow-empty', '-m', message]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']);
}

function prepare(index: number, dir: string) {
  const scenario = scenarios[index];
  const { base, change } = branches(index);
  mkdirSync(dir, { recursive: true });
  const fixtures = join(E2E, 'fixtures');
  for (const file of sh(fixtures, 'git', ['ls-files', '.']).split('\n')) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(fixtures, file), join(dir, file));
  }
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'github-actions[bot]']);
  sh(dir, 'git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  commitAll(dir, 'Fixtures');
  sh(dir, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);

  // Every stack starts deployed, as in a real repository
  const deploy = sh(dir, 'node', [
    join(TOOL, 'src/cli.ts'),
    'run',
    '--mode',
    'up',
    '--base',
    'HEAD',
    '--all',
  ]);
  const failed = (JSON.parse(deploy) as { status: string }[]).filter(
    (run) => run.status === 'failed',
  );
  if (failed.length > 0) throw new Error(`The initial deploy failed: ${deploy}`);
  const baseSha = commitAll(dir, 'Commit the encryption salts Pulumi wrote');
  retried(dir, 'git', ['push', '-q', remote(), `HEAD:refs/heads/${base}`]);

  for (const [path, content] of Object.entries(scenario.changes)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    execFileSync(
      'sh',
      ['-c', content === null ? `rm -f "$1"` : `cat > "$1"`, 'sh', join(dir, path)],
      {
        input: content ?? '',
      },
    );
  }
  commitAll(dir, scenario.name);
  retried(dir, 'git', ['push', '-q', remote(), `HEAD:refs/heads/${change}`]);

  const url = retried(dir, 'gh', [
    'pr',
    'create',
    '--repo',
    repository,
    '--draft',
    '--base',
    base,
    '--head',
    change,
    '--title',
    `e2e: ${scenario.name}`,
    '--body',
    scenario.body ?? `End-to-end scenario "${scenario.name}"; closed automatically.`,
  ]);
  output('pull-request', url.split('/').pop() ?? '');
  output('base-sha', baseSha);
}

function comments(number: string) {
  const raw = sh(TOOL, 'gh', [
    'api',
    '--paginate',
    `repos/${repository}/issues/${number}/comments`,
  ]);
  return (JSON.parse(raw.replace(/\]\s*\[/g, ',')) as { body: string }[]).map(
    (comment) => comment.body,
  );
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function ids(results: string, statusFilter?: (status: string) => boolean) {
  const runs = JSON.parse(results || '[]') as { id: string; status: string }[];
  return runs
    .filter((run) => !statusFilter || statusFilter(run.status))
    .map((run) => run.id)
    .sort();
}

function assertRuns(kind: string, actual: string[], expected: string[], results: string) {
  const failed = ids(results, (status) => status === 'failed' || status === 'skipped');
  check(failed.length === 0, `${kind}: failed or skipped stacks: ${failed.join(', ')}`);
  check(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${kind} ran ${JSON.stringify(actual)}, expected ${JSON.stringify([...expected].sort())}`,
  );
}

function assertPreview(index: number, number: string, results: string) {
  const scenario = scenarios[index];
  assertRuns('preview', ids(results), scenario.expected, results);
  const previews = comments(number).filter((body) =>
    body.startsWith('<!-- pulumi-affected:preview:'),
  );
  if (scenario.expected.length === 0) {
    check(previews.length === 0, 'a preview comment was posted although no stack was selected');
    return;
  }
  check(previews.length === 1, `expected one preview comment, found ${previews.length}`);
  for (const id of scenario.expected)
    check(previews[0].includes(`<code>${id}</code>`), `the preview comment doesn't mention ${id}`);
}

function assertDeploy(index: number, number: string, results: string) {
  const scenario = scenarios[index];
  assertRuns('deploy', ids(results), scenario.deployed, results);
  const deploys = comments(number).filter((body) =>
    body.startsWith('<!-- pulumi-affected:deploy-'),
  );
  // Nothing deployed means no deploy comment
  const expectedComments = scenario.deployed.length > 0 ? 1 : 0;
  check(
    deploys.length === expectedComments,
    `expected ${expectedComments} deploy comments, found ${deploys.length}`,
  );
  for (const id of scenario.deployed)
    check(deploys[0].includes(`<code>${id}</code>`), `the deploy comment doesn't mention ${id}`);
}

function merge(index: number, number: string, dir: string) {
  sh(TOOL, 'gh', ['pr', 'ready', number, '--repo', repository]);
  retried(TOOL, 'gh', ['pr', 'merge', number, '--repo', repository, '--squash']);
  sh(dir, 'git', ['fetch', '-q', remote(), branches(index).base]);
  sh(dir, 'git', ['checkout', '-q', 'FETCH_HEAD']);
}

function cleanup(index: number, number: string | undefined) {
  if (number) {
    try {
      sh(TOOL, 'gh', ['pr', 'close', number, '--repo', repository]);
    } catch {
      // Already merged or closed
    }
  }
  for (const branch of Object.values(branches(index))) {
    try {
      sh(TOOL, 'gh', ['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`]);
    } catch {
      // Never pushed, or already deleted
    }
  }
}

const [command, indexText, ...rest] = process.argv.slice(2);
const index = Number(indexText);
if (command === 'list')
  console.log(JSON.stringify(scenarios.map((scenario, i) => ({ index: i, name: scenario.name }))));
else if (command === 'prepare') prepare(index, rest[0]);
else if (command === 'assert-preview') assertPreview(index, rest[0], process.env.RESULTS ?? '');
else if (command === 'merge') merge(index, rest[0], rest[1]);
else if (command === 'assert-deploy') assertDeploy(index, rest[0], process.env.RESULTS ?? '');
else if (command === 'cleanup') cleanup(index, rest[0]);
else throw new Error(`Unknown command ${command}`);
