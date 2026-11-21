import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * Drives the end-to-end test of one scenario in this repository, as the e2e workflow's steps.
 * The workflow between them is the example from the README: select on the pull request, preview
 * the selected stacks with --save-plan, keep only the plans with changes, and after merge apply
 * exactly those plans.
 *
 *   prepare        copies e2e/fixtures into a repository of its own, deploys every stack, pushes
 *                  it as a throwaway base branch, pushes the scenario's change as a second branch,
 *                  and opens a draft pull request between them
 *   assert-select  checks the selection
 *   assert-plans   checks which stacks previewed with changes, or failed
 *   merge          squash-merges the pull request and checks out the result
 *   assert-apply   checks which plans were applied
 *   cleanup        closes the pull request and deletes both branches
 */

interface Scenario {
  name: string;
  changes: Record<string, string | null>;
  /** The change's commit message, for Pulumi-Affected-Run/Skip lines */
  message?: string;
  /** Stacks selected */
  expected: string[];
  /** Stacks a Pulumi-Affected-Skip line left out */
  skipped?: string[];
  /** Selected stacks whose preview fails */
  failing?: string[];
  /** Selected stacks whose preview has changes, so whose plan is kept */
  changed: string[];
  /** Stacks whose plan is applied after merge */
  applied: string[];
  /** A line printed before Pulumi's output, like a wrapper's banner */
  banner?: string;
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

  // Every stack starts deployed, in dependency order, as in a real repository
  const all = JSON.parse(
    sh(dir, 'node', [join(TOOL, 'src/cli.ts'), 'select', '--base', 'HEAD', '--all']),
  ) as { waves: string[][]; stacks: { id: string; dir: string; stack: string }[] };
  for (const wave of all.waves) {
    for (const id of wave) {
      const stack = all.stacks.find((candidate) => candidate.id === id);
      if (!stack) continue;
      sh(dir, 'pulumi', ['--cwd', stack.dir, 'stack', 'init', stack.stack, '--non-interactive']);
      sh(dir, 'pulumi', [
        '--cwd',
        stack.dir,
        '--stack',
        stack.stack,
        'up',
        '--yes',
        '--non-interactive',
        '--skip-preview',
      ]);
    }
  }
  const baseSha = commitAll(dir, 'Commit the encryption salts Pulumi wrote');
  retried(dir, 'git', ['push', '-q', remote(), `HEAD:refs/heads/${base}`]);

  writeChanges(dir, scenario.changes);
  const head = commitAll(dir, scenario.message ?? scenario.name);
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
    `End-to-end scenario "${scenario.name}"; closed automatically.`,
  ]);
  output('pull-request', url.split('/').pop() ?? '');
  output('base-sha', baseSha);
  output('head-sha', head);
  output('banner', scenario.banner ?? '');
}

function writeChanges(dir: string, changes: Record<string, string | null>) {
  for (const [path, content] of Object.entries(changes)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    execFileSync(
      'sh',
      ['-c', content === null ? `rm -f "$1"` : `cat > "$1"`, 'sh', join(dir, path)],
      {
        input: content ?? '',
      },
    );
  }
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function same(actual: string[], expected: string[], what: string) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  check(
    JSON.stringify(a) === JSON.stringify(e),
    `${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`,
  );
}

/** Stack ids from plan or preview file names: "plans/fixture-accounts__shop.preview.json" */
function idsOf(files: string[]) {
  return files.map((file) =>
    file
      .slice(file.lastIndexOf('/') + 1)
      .split('.')[0]
      .replace('__', '/'),
  );
}

function assertSelect(index: number, file: string) {
  const scenario = scenarios[index];
  const selection = JSON.parse(readFileSync(file, 'utf8')) as {
    stacks: { id: string }[];
    skipped: { id: string }[];
    warnings: string[];
  };
  same(
    selection.stacks.map((stack) => stack.id),
    scenario.expected,
    'selected',
  );
  same(
    selection.skipped.map((stack) => stack.id),
    scenario.skipped ?? [],
    'skipped',
  );
  check(selection.warnings.length === 0, `warnings: ${selection.warnings.join('; ')}`);
}

function assertPlans(index: number) {
  const scenario = scenarios[index];
  // The plan step fails only when a stack fails to preview, which some scenarios want
  const expectedOutcome = scenario.failing?.length ? 'failure' : 'success';
  check(
    process.env.PLAN_OUTCOME === expectedOutcome,
    `the plan step was ${process.env.PLAN_OUTCOME}, expected ${expectedOutcome}`,
  );
  same(idsOf(JSON.parse(process.env.FAILED || '[]')), scenario.failing ?? [], 'failed previews');
  same(idsOf(JSON.parse(process.env.CHANGED || '[]')), scenario.changed, 'previews with changes');
}

function merge(number: string, index: number, dir: string, planned: string) {
  retried(TOOL, 'gh', ['pr', 'ready', number, '--repo', repository]);
  retried(TOOL, 'gh', ['pr', 'merge', number, '--repo', repository, '--squash']);
  retried(dir, 'git', ['fetch', '-q', remote(), branches(index).base]);
  sh(dir, 'git', ['checkout', '-q', 'FETCH_HEAD']);
  // The plans are only valid for exactly the code they were made from
  const mergedTree = sh(dir, 'git', ['rev-parse', 'HEAD^{tree}']);
  const plannedTree = sh(dir, 'git', ['rev-parse', `${planned}^{tree}`]);
  check(
    mergedTree === plannedTree,
    `the merged tree ${mergedTree} isn't the planned ${plannedTree}`,
  );
}

function assertApply(index: number) {
  const scenario = scenarios[index];
  const applied = existsSync('applied.txt')
    ? readFileSync('applied.txt', 'utf8').split('\n').filter(Boolean)
    : [];
  same(applied, scenario.applied, 'applied');
}

function cleanup(index: number, number: string | undefined) {
  if (number) {
    try {
      retried(TOOL, 'gh', ['pr', 'close', number, '--repo', repository]);
    } catch {
      // Already merged or closed
    }
  }
  for (const branch of Object.values(branches(index))) {
    try {
      retried(TOOL, 'gh', ['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`]);
    } catch {
      // Never pushed, or already deleted
    }
  }
}

const [command, indexText, ...rest] = process.argv.slice(2);
const index = Number(indexText);
if (command === 'list') {
  console.log(JSON.stringify(scenarios.map((scenario, i) => ({ index: i, name: scenario.name }))));
} else if (command === 'prepare') prepare(index, rest[0]);
else if (command === 'assert-select') assertSelect(index, rest[0]);
else if (command === 'assert-plans') assertPlans(index);
else if (command === 'merge') merge(rest[0], index, rest[1], rest[2]);
else if (command === 'assert-apply') assertApply(index);
else if (command === 'cleanup') cleanup(index, rest[0]);
else throw new Error(`Unknown command ${command}`);
