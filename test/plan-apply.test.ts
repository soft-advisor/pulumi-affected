import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { applyPlans } from '../src/plan/apply.ts';
import { readManifest } from '../src/plan/manifest.ts';
import { planStacks } from '../src/plan/plan.ts';
import { commandRunner, DEFAULT_COMMAND } from '../src/pulumi/runner.ts';
import { commit, createRepo, type Files, run } from './helpers.ts';

/*
 * Plans and applies with the real Pulumi CLI, against a local file backend, using YAML programs
 * and the random provider so nothing needs installing per test. Skipped without Pulumi.
 */

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const program = (length: number, extra = '') => `name: words
runtime: yaml
resources:
  word:
    type: random:RandomString
    properties:
      length: ${length}
      special: false
${extra}outputs:
  word: \${word.result}
`;

const backends: string[] = [];
const saved = { ...process.env };

before(() => {
  process.env.PULUMI_CONFIG_PASSPHRASE = 'test';
  process.env.PULUMI_SKIP_UPDATE_CHECK = 'true';
});

after(() => {
  process.env = saved;
  for (const backend of backends) rmSync(backend, { recursive: true, force: true });
});

/** A repo with the `words` project, and a fresh backend; tests run one at a time */
function setup(files: Files = {}) {
  const backend = mkdtempSync(join(tmpdir(), 'pulumi-affected-state-'));
  backends.push(backend);
  process.env.PULUMI_BACKEND_URL = `file://${backend}`;
  const { dir, base } = createRepo({
    'Pulumi.yaml': program(8),
    'Pulumi.dev.yaml': 'config: {}\n',
    ...files,
  });
  const runner = commandRunner(DEFAULT_COMMAND, dir);
  const plans = mkdtempSync(join(tmpdir(), 'pulumi-affected-plans-'));
  return { dir, base, runner, plans };
}

function pulumi(dir: string, args: string[]) {
  return run(dir, 'pulumi', ['--non-interactive', '--stack', 'dev', ...args]);
}

/** Creates the dev stack, commits the encryption salt Pulumi adds to its config, and deploys */
function deploy(dir: string) {
  pulumi(dir, ['stack', 'init']);
  commit(dir, {}, 'salt');
  pulumi(dir, ['up', '--yes', '--skip-preview']);
  assert.equal(run(dir, 'git', ['status', '--porcelain']), '');
}

describe('plan and apply', { skip: !hasPulumi && 'pulumi is not installed' }, () => {
  test('applies the plan once, and a rerun recognises it as applied', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });

    const manifest = await planStacks({
      select: { cwd: dir, base },
      directory: plans,
      runner,
      concurrency: 2,
      createStacks: 'plan',
    });
    assert.deepEqual(manifest.failed, []);
    assert.deepEqual(
      manifest.stacks.map((stack) => [stack.id, stack.state.kind]),
      [['words/dev', 'exists']],
    );
    assert.equal(readManifest(plans).stacks.length, 1);

    const first = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 2 });
    assert.deepEqual(first.stacks, [{ id: 'words/dev', outcome: 'applied' }]);
    const word = JSON.parse(pulumi(dir, ['stack', 'output', '--json'])).word;
    assert.equal(word.length, 12);

    const second = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 2 });
    assert.deepEqual(second.stacks, [{ id: 'words/dev', outcome: 'already-applied' }]);
    assert.ok(second.ok);
  });

  test('refuses a plan when the state changed after planning', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });
    await planStacks({
      select: { cwd: dir, base },
      directory: plans,
      runner,
      concurrency: 1,
      createStacks: 'plan',
    });

    // Someone else changes the stack in the meantime
    pulumi(dir, [
      'up',
      '--yes',
      '--skip-preview',
      '--replace',
      'urn:pulumi:dev::words::random:index/randomString:RandomString::word',
    ]);

    const result = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 });
    assert.equal(result.stacks[0].outcome, 'refused');
    assert.ok(!result.ok);
  });

  test('drops plans without changes', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': `${program(8)}# a comment\n` });

    const manifest = await planStacks({
      select: { cwd: dir, base },
      directory: plans,
      runner,
      concurrency: 1,
      createStacks: 'plan',
    });
    assert.deepEqual(manifest.stacks, []);
    assert.deepEqual(
      manifest.unchanged.map((stack) => stack.id),
      ['words/dev'],
    );
    assert.ok(!existsSync(join(plans, 'words__dev.plan.json')));
  });

  test('creates a new stack when planning', async () => {
    const { dir, base, runner, plans } = setup();
    commit(dir, { 'Pulumi.prod.yaml': 'config: {}\n' });
    const manifest = await planStacks({
      select: { cwd: dir, base, run: ['words/prod'] },
      directory: plans,
      runner,
      concurrency: 1,
      createStacks: 'plan',
    });
    const prod = manifest.stacks.find((stack) => stack.id === 'words/prod');
    assert.equal(prod?.created, true);
    assert.equal(prod?.state.kind, 'exists');
    // Pulumi wrote an encryption salt into the config file; that doesn't stop applying
    assert.notEqual(run(dir, 'git', ['status', '--porcelain']), '');
    const result = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 });
    assert.deepEqual(
      result.stacks.filter((stack) => stack.id === 'words/prod'),
      [{ id: 'words/prod', outcome: 'applied' }],
    );
  });

  test('creates a new stack only when applying, if asked to', async () => {
    const { dir, base, runner, plans } = setup();
    commit(dir, { 'Pulumi.qa.yaml': 'config: {}\n' });
    const config = readFileSync(join(dir, 'Pulumi.qa.yaml'), 'utf8');
    const manifest = await planStacks({
      select: { cwd: dir, base, run: ['words/qa'] },
      directory: plans,
      runner,
      concurrency: 1,
      createStacks: 'apply',
    });
    assert.deepEqual(manifest.failed, []);
    const qa = manifest.stacks.find((stack) => stack.id === 'words/qa');
    assert.equal(qa?.state.kind, 'created-on-apply');
    // Nothing reached the real backend, and the config file is as committed
    assert.doesNotMatch(run(dir, 'pulumi', ['stack', 'ls', '--json']), /"name":\s*"qa"/);
    assert.equal(readFileSync(join(dir, 'Pulumi.qa.yaml'), 'utf8'), config);

    const result = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 });
    assert.deepEqual(
      result.stacks.filter((stack) => stack.id === 'words/qa'),
      [{ id: 'words/qa', outcome: 'applied' }],
    );
    run(dir, 'git', ['checkout', '-q', '--', '.']);
    const again = await applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 });
    assert.equal(again.stacks.find((stack) => stack.id === 'words/qa')?.outcome, 'already-applied');
  });

  test('refuses plans for other code, or a tampered plan', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });
    await planStacks({
      select: { cwd: dir, base },
      directory: plans,
      runner,
      concurrency: 1,
      createStacks: 'plan',
    });

    const planFile = join(plans, 'words__dev.plan.json');
    const original = readFileSync(planFile, 'utf8');
    writeFileSync(planFile, `${original} `);
    await assert.rejects(
      applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 }),
      /doesn't match its hash/,
    );
    writeFileSync(planFile, original);

    commit(dir, { 'Pulumi.yaml': program(16) });
    await assert.rejects(
      applyPlans({ cwd: dir, directory: plans, runner, concurrency: 1 }),
      /are for tree/,
    );
  });
});
