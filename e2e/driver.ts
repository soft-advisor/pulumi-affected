import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * Drives the end-to-end test of one scenario in this repository, as the e2e workflow's steps.
 * The workflow between them is the example from the README: the plan action on the pull request,
 * and after merge the apply action, which finds the plans' artifact by the merged tree.
 *
 *   prepare        copies e2e/fixtures into a repository of its own, deploys every stack, pushes
 *                  it as a throwaway base branch, pushes the scenario's change as a second branch,
 *                  and opens a draft pull request between them
 *   assert-select  checks the selection
 *   assert-plans   checks which stacks have plans, or failed
 *   merge          squash-merges the pull request and checks out the result, as a fresh checkout
 *   change-state   updates a stack between planning and applying, as someone else might
 *   assert-apply   checks which plans were applied or refused, and that applying again is a no-op
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
  /** A stack to update after planning, so applying its plan is refused */
  changeState?: string;
  /** Stacks whose plan is refused */
  refused?: string[];
  /** Stacks skipped because a stack they read changed outputs after they were planned */
  replan?: string[];
  /** A line printed before Pulumi's output, like a wrapper's banner */
  banner?: string;
  /** The package manager the fixtures use; npm when absent */
  packageManager?: PackageManager;
  /** Changed files taken from e2e/package-managers: repository path → path there */
  changesFrom?: Record<string, string>;
}

type PackageManager = 'npm' | 'yarn-classic' | 'yarn-berry' | 'pnpm';

/** How each package manager installs exactly what its lockfile says, without install scripts */
const INSTALL: Record<PackageManager, string[]> = {
  npm: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  'yarn-classic': ['corepack', 'yarn', 'install', '--frozen-lockfile', '--ignore-scripts'],
  'yarn-berry': ['corepack', 'yarn', 'install', '--immutable', '--mode=skip-build'],
  pnpm: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
};

/** The scenario's changes, including files from e2e/package-managers */
export function scenarioChanges(scenario: Scenario) {
  const changes: Record<string, string | null> = { ...scenario.changes };
  for (const [path, from] of Object.entries(scenario.changesFrom ?? {})) {
    changes[path] = readFileSync(join(E2E, 'package-managers', from), 'utf8');
  }
  return changes;
}

/** Puts a package manager's base manifest and lockfile in place of npm's */
function usePackageManager(dir: string, manager: PackageManager) {
  if (manager === 'npm') return;
  rmSync(join(dir, 'package-lock.json'), { force: true });
  const base = join(E2E, 'package-managers', manager, 'base');
  for (const file of readdirSync(base)) cpSync(join(base, file), join(dir, file));
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
  const manager = scenario.packageManager ?? 'npm';
  usePackageManager(dir, manager);
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'github-actions[bot]']);
  sh(dir, 'git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  commitAll(dir, 'Fixtures');
  const [installer, ...installArgs] = INSTALL[manager];
  sh(dir, installer, installArgs);

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

  writeChanges(dir, scenarioChanges(scenario));
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

interface Manifest {
  stacks: { id: string }[];
  failed: { id: string }[];
}

function assertPlans(index: number, directory: string) {
  const scenario = scenarios[index];
  // The plan action fails only when a stack fails to preview, which some scenarios want
  const expectedOutcome = scenario.failing?.length ? 'failure' : 'success';
  check(
    process.env.PLAN_OUTCOME === expectedOutcome,
    `the plan step was ${process.env.PLAN_OUTCOME}, expected ${expectedOutcome}`,
  );
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  same(
    manifest.failed.map((stack) => stack.id),
    scenario.failing ?? [],
    'failed previews',
  );
  same(
    manifest.stacks.map((stack) => stack.id),
    scenario.changed,
    'plans',
  );
}

function merge(number: string, index: number, dir: string, planned: string) {
  retried(TOOL, 'gh', ['pr', 'ready', number, '--repo', repository]);
  retried(TOOL, 'gh', ['pr', 'merge', number, '--repo', repository, '--squash']);
  retried(dir, 'git', ['fetch', '-q', remote(), branches(index).base]);
  // Forced, like a fresh checkout: planning may have written encryption salts to config files
  sh(dir, 'git', ['checkout', '-q', '-f', 'FETCH_HEAD']);
  // The plans are only valid for exactly the code they were made from
  const mergedTree = sh(dir, 'git', ['rev-parse', 'HEAD^{tree}']);
  const plannedTree = sh(dir, 'git', ['rev-parse', `${planned}^{tree}`]);
  check(
    mergedTree === plannedTree,
    `the merged tree ${mergedTree} isn't the planned ${plannedTree}`,
  );
}

function changeState(index: number, dir: string) {
  const id = scenarios[index].changeState;
  if (!id) return;
  const [project, stack] = id.split('/');
  const selection = JSON.parse(
    sh(dir, 'node', [join(TOOL, 'src/cli.ts'), 'select', '--base', 'HEAD', '--run', id]),
  ) as { stacks: { id: string; dir: string }[] };
  const folder = selection.stacks.find((candidate) => candidate.id === id)?.dir ?? '';
  const exported = JSON.parse(
    sh(dir, 'pulumi', ['--cwd', folder, '--stack', stack, 'stack', 'export']),
  ) as { deployment: { resources: { urn: string; type: string }[] } };
  const resource = exported.deployment.resources.find((candidate) =>
    candidate.type.startsWith('random:'),
  );
  check(resource !== undefined, `${project} has no random resource to replace`);
  sh(dir, 'pulumi', [
    '--cwd',
    folder,
    '--stack',
    stack,
    'up',
    '--yes',
    '--non-interactive',
    '--skip-preview',
    '--replace',
    resource?.urn ?? '',
  ]);
}

interface ApplyResult {
  stacks: { id: string; outcome: string }[];
}

function assertApply(index: number) {
  const scenario = scenarios[index];
  const refused = scenario.refused ?? [];
  const replan = scenario.replan ?? [];
  // Applying fails when planning failed, or a plan is refused or skipped
  const expectedOutcome =
    scenario.failing?.length || refused.length || replan.length ? 'failure' : 'success';
  check(
    process.env.APPLY_OUTCOME === expectedOutcome,
    `the apply step was ${process.env.APPLY_OUTCOME}, expected ${expectedOutcome}`,
  );
  const result = JSON.parse(process.env.APPLY_RESULT || '{"stacks":[]}') as ApplyResult;
  const withOutcome = (outcome: string, of: ApplyResult) =>
    of.stacks.filter((stack) => stack.outcome === outcome).map((stack) => stack.id);
  same(withOutcome('applied', result), scenario.applied, 'applied');
  same(withOutcome('refused', result), refused, 'refused');
  same(withOutcome('skipped', result), replan, 'skipped to plan again');
  if (expectedOutcome === 'success') {
    // Applying the same plans again finds them all applied already
    const again = JSON.parse(process.env.REAPPLY_RESULT || '{"stacks":[]}') as ApplyResult;
    same(withOutcome('already-applied', again), scenario.applied, 'already applied on a rerun');
    same(
      again.stacks.map((stack) => stack.id),
      scenario.applied,
      'stacks on a rerun',
    );
  }
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
else if (command === 'assert-plans') assertPlans(index, rest[0]);
else if (command === 'merge') merge(rest[0], index, rest[1], rest[2]);
else if (command === 'change-state') changeState(index, rest[0]);
else if (command === 'assert-apply') assertApply(index);
else if (command === 'cleanup') cleanup(index, rest[0]);
else throw new Error(`Unknown command ${command}`);
