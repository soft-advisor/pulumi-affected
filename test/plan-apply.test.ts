import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { type ApplyResult, applyPlans } from '../src/plan/apply.ts';
import { readManifest } from '../src/plan/manifest.ts';
import { planStacks } from '../src/plan/plan.ts';
import { commandRunner, DEFAULT_COMMAND, type PulumiRunner } from '../src/pulumi/runner.ts';
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

const program = (length: number, outputs = '') => `name: words
runtime: yaml
resources:
  word:
    type: random:RandomString
    properties:
      length: ${length}
      special: false
outputs:
  word: \${word.result}
${outputs}`;

const folders: string[] = [];
const saved = { ...process.env };

before(() => {
  process.env.PULUMI_CONFIG_PASSPHRASE = 'test';
  process.env.PULUMI_SKIP_UPDATE_CHECK = 'true';
});

after(() => {
  process.env = saved;
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function temporary(name: string) {
  const folder = mkdtempSync(join(tmpdir(), `pulumi-affected-${name}-`));
  folders.push(folder);
  return folder;
}

/** A repo with `files` (the `words` project by default), and a fresh backend */
function setup(files: Files = { 'Pulumi.yaml': program(8), 'Pulumi.dev.yaml': 'config: {}\n' }) {
  process.env.PULUMI_BACKEND_URL = `file://${temporary('state')}`;
  const { dir, base } = createRepo(files);
  return { dir, base, runner: commandRunner(DEFAULT_COMMAND, dir), plans: temporary('plans') };
}

function pulumi(dir: string, args: string[]) {
  return run(dir, 'pulumi', ['--non-interactive', '--stack', 'dev', ...args]);
}

/** Creates the dev stack in `folder`, commits the salt Pulumi adds to its config, and deploys */
function deploy(dir: string, folder = '.') {
  pulumi(dir, ['--cwd', folder, 'stack', 'init']);
  commit(dir, {}, 'salt');
  pulumi(dir, ['--cwd', folder, 'up', '--yes', '--skip-preview']);
  assert.equal(run(dir, 'git', ['status', '--porcelain']), '');
}

const plan = (dir: string, base: string, plans: string, runner: PulumiRunner) =>
  planStacks({ select: { cwd: dir, base }, directory: plans, runner, concurrency: 2 });

const apply = (dir: string, plans: string, runner: PulumiRunner, allow?: string[]) =>
  applyPlans({ cwd: dir, directory: plans, runner, concurrency: 2, allow });

const outcomes = (result: ApplyResult) =>
  Object.fromEntries(result.stacks.map((stack) => [stack.id, stack.outcome]));

describe('plan and apply', { skip: !hasPulumi && 'pulumi is not installed' }, () => {
  test('applies the plan once, and a rerun recognises it as applied', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });

    const manifest = await plan(dir, base, plans, runner);
    assert.deepEqual(manifest.failed, []);
    assert.deepEqual(
      manifest.stacks.map((stack) => stack.id),
      ['words/dev'],
    );
    assert.equal(readManifest(plans).stacks.length, 1);

    const first = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(first), { 'words/dev': 'applied' });
    assert.equal(JSON.parse(pulumi(dir, ['stack', 'output', '--json'])).word.length, 12);

    // A refresh in between doesn't make the plan look unapplied
    pulumi(dir, ['refresh', '--yes', '--skip-preview']);
    const second = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(second), { 'words/dev': 'already-applied' });
    assert.ok(second.ok);
  });

  test('refuses a plan when the state changed after planning', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });
    await plan(dir, base, plans, runner);

    // Someone else changes the stack in the meantime
    pulumi(dir, [
      'up',
      '--yes',
      '--skip-preview',
      '--replace',
      'urn:pulumi:dev::words::random:index/randomString:RandomString::word',
    ]);

    const result = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(result), { 'words/dev': 'refused' });
    assert.ok(!result.ok);
  });

  test('drops plans without changes, and keeps plans that only change outputs', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': `${program(8)}# a comment\n` });
    const unchanged = await plan(dir, base, plans, runner);
    assert.deepEqual(unchanged.stacks, []);
    assert.deepEqual(
      unchanged.unchanged.map((stack) => stack.id),
      ['words/dev'],
    );
    assert.ok(!existsSync(join(plans, 'words+dev.plan.json')));

    commit(dir, { 'Pulumi.yaml': program(8, '  greeting: hello\n') });
    const outputs = await plan(dir, base, plans, runner);
    assert.deepEqual(
      outputs.stacks.map((stack) => [stack.id, stack.outputs]),
      [['words/dev', ['greeting']]],
    );
    const result = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(result), { 'words/dev': 'applied' });
    assert.equal(JSON.parse(pulumi(dir, ['stack', 'output', '--json'])).greeting, 'hello');
  });

  test('creates a new stack with secrets when planning, and applies it from a fresh clone', async () => {
    const { dir, base, runner, plans } = setup({
      'Pulumi.yaml': `name: secrets
runtime: yaml
resources:
  password:
    type: random:RandomPassword
    properties:
      length: 16
outputs:
  password: \${password.result}
`,
    });
    commit(dir, { 'Pulumi.prod.yaml': 'config: {}\n' });
    const manifest = await plan(dir, base, plans, runner);
    const prod = manifest.stacks.find((stack) => stack.id === 'secrets/prod');
    assert.equal(prod?.created, true);
    assert.match(prod?.encryptionSalt ?? '', /^v1:/);

    // The apply job's checkout doesn't have the salt Pulumi wrote while planning
    const clone = temporary('clone');
    run(tmpdir(), 'git', ['clone', '-q', dir, clone]);
    const result = await apply(clone, plans, commandRunner(DEFAULT_COMMAND, clone));
    assert.deepEqual(outcomes(result), { 'secrets/prod': 'applied' });
  });

  test('a stack reading outputs another plan changes is planned after it, never with it', async () => {
    const up = (word: string) => `name: up\nruntime: yaml\noutputs:\n  word: ${word}\n`;
    const down = (suffix: string) => `name: down
runtime: yaml
resources:
  ref:
    type: pulumi:pulumi:StackReference
    properties:
      name: organization/up/dev
outputs:
  word: \${ref.outputs["word"]}${suffix}
`;
    const { dir, base, runner, plans } = setup({
      'up/Pulumi.yaml': up('one'),
      'up/Pulumi.dev.yaml': 'config: {}\n',
      'down/Pulumi.yaml': down(''),
      'down/Pulumi.dev.yaml': 'config: {}\n',
      'pulumi-affected.yaml': 'dependsOn:\n  down/dev: [up/dev]\n',
    });
    deploy(dir, 'up');
    deploy(dir, 'down');

    // Both change: down's plan would read up's old outputs, so planning fails for it
    commit(dir, { 'up/Pulumi.yaml': up('two'), 'down/Pulumi.yaml': down('!') });
    const both = await plan(dir, base, plans, runner);
    assert.deepEqual(
      both.stacks.map((stack) => stack.id),
      ['up/dev'],
    );
    assert.deepEqual(
      both.failed.map((stack) => [stack.id, stack.blockedBy?.map((read) => read.dependency)]),
      [['down/dev', ['up/dev']]],
    );
    await assert.rejects(apply(dir, plans, runner), /Planning failed for down\/dev/);

    // Only up changes: down is to be planned again once up is applied
    commit(dir, { 'down/Pulumi.yaml': down('') });
    const only = await plan(dir, base, plans, runner);
    assert.deepEqual(
      only.followUps.map((read) => [read.id, read.dependency, read.outputs]),
      [['down/dev', 'up/dev', ['word']]],
    );
    const result = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(result), { 'up/dev': 'applied' });
    assert.deepEqual(result.needsPlan, ['down/dev']);
  });

  test('refuses tampered plans, other code, extra files and stacks not allowed', async () => {
    const { dir, base, runner, plans } = setup();
    deploy(dir);
    commit(dir, { 'Pulumi.yaml': program(12) });
    await plan(dir, base, plans, runner);

    const planFile = join(plans, 'words+dev.plan.json');
    const original = readFileSync(planFile, 'utf8');
    writeFileSync(planFile, `${original} `);
    await assert.rejects(apply(dir, plans, runner), /doesn't match its hash/);
    writeFileSync(planFile, original);

    await assert.rejects(apply(dir, plans, runner, ['other/*']), /isn't one of the stacks allowed/);

    // A project that isn't in the commit can't be applied, or even sit beside it
    mkdirSync(join(dir, 'planted'));
    writeFileSync(join(dir, 'planted', 'Pulumi.yaml'), 'name: planted\nruntime: yaml\n');
    await assert.rejects(
      apply(dir, plans, runner),
      /files the commit doesn't: planted\/Pulumi.yaml/,
    );
    rmSync(join(dir, 'planted'), { recursive: true });

    commit(dir, { 'Pulumi.yaml': program(16) });
    await assert.rejects(apply(dir, plans, runner), /are for tree/);
  });

  test('refuses plans for stacks the change does not select', async () => {
    const named = (name: string, length: number) =>
      program(length).replace('name: words', `name: ${name}`);
    const { dir, runner, plans } = setup({
      'a/Pulumi.yaml': named('a', 8),
      'a/Pulumi.dev.yaml': 'config: {}\n',
      'b/Pulumi.yaml': named('b', 8),
      'b/Pulumi.dev.yaml': 'config: {}\n',
    });
    deploy(dir, 'a');
    deploy(dir, 'b');
    const base = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'a/Pulumi.yaml': named('a', 12), 'b/Pulumi.yaml': named('b', 12) });
    await plan(dir, base, plans, runner);
    // Applied as a change that only touches a (a base after b's change): b's plan isn't its
    const onlyA = commit(dir, {}, 'empty');
    assert.ok(onlyA);
    await assert.rejects(
      applyPlans({
        cwd: dir,
        directory: plans,
        runner,
        concurrency: 2,
        select: { base, skip: ['b/dev'] },
      }),
      /b\/dev has a plan, but this change doesn't select it/,
    );
  });

  test('applies stacks that depend on each other in a cycle, one at a time', async () => {
    const quiet = (name: string, length: number) =>
      `name: ${name}\nruntime: yaml\nresources:\n  word:\n    type: random:RandomString\n    properties:\n      length: ${length}\n`;
    const { dir, runner, plans } = setup({
      'a/Pulumi.yaml': quiet('a', 8),
      'a/Pulumi.dev.yaml': 'config: {}\n',
      'b/Pulumi.yaml': quiet('b', 8),
      'b/Pulumi.dev.yaml': 'config: {}\n',
      'pulumi-affected.yaml': 'dependsOn:\n  a/dev: [b/dev]\n  b/dev: [a/dev]\n',
    });
    deploy(dir, 'a');
    deploy(dir, 'b');
    const base = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'a/Pulumi.yaml': quiet('a', 9), 'b/Pulumi.yaml': quiet('b', 9) });
    const manifest = await plan(dir, base, plans, runner);
    assert.deepEqual(manifest.failed, []);
    const result = await apply(dir, plans, runner);
    assert.deepEqual(outcomes(result), { 'a/dev': 'applied', 'b/dev': 'applied' });
  });

  describe('stacks created on apply', () => {
    const empty = (name: string, outputs = '  ready: yes\n') =>
      `name: ${name}\nruntime: yaml\noutputs:\n${outputs}`;

    test('an empty new stack is created by apply, and its resources come in a later change', async () => {
      const { dir, base, runner, plans } = setup({ 'Pulumi.yaml': empty('fresh') });
      commit(dir, { 'Pulumi.prod.yaml': 'config: {}\n' });
      const manifest = await planStacks({
        select: { cwd: dir, base },
        directory: plans,
        runner,
        concurrency: 1,
        createStacks: 'apply',
      });
      assert.deepEqual(manifest.failed, []);
      assert.deepEqual(
        manifest.stacks.map((stack) => [stack.id, stack.createOnApply, stack.fingerprint]),
        [['fresh/prod', true, undefined]],
      );
      // Nothing reached the real backend, and the config file is as committed
      assert.doesNotMatch(run(dir, 'pulumi', ['stack', 'ls', '--json']), /"name":\s*"prod"/);
      assert.equal(run(dir, 'git', ['status', '--porcelain']), '');

      // Applied from a fresh clone, as an apply job would
      const clone = temporary('clone');
      run(tmpdir(), 'git', ['clone', '-q', dir, clone]);
      const cloneRunner = commandRunner(DEFAULT_COMMAND, clone);
      const result = await apply(clone, plans, cloneRunner);
      assert.deepEqual(outcomes(result), { 'fresh/prod': 'applied' });
      assert.equal(
        JSON.parse(run(clone, 'pulumi', ['--stack', 'prod', 'stack', 'output', '--json'])).ready,
        'yes',
      );
      const again = await apply(clone, plans, cloneRunner);
      assert.deepEqual(outcomes(again), { 'fresh/prod': 'already-applied' });

      // The follow-up adds resources with a secret, planned and applied in fresh clones that
      // don't have the salt Pulumi wrote when apply created the stack
      const followUpBase = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
      commit(dir, {
        'Pulumi.yaml': `name: fresh\nruntime: yaml\nresources:\n  password:\n    type: random:RandomPassword\n    properties:\n      length: 12\noutputs:\n  ready: yes\n  password: \${password.result}\n`,
      });
      const planClone = temporary('plan-clone');
      run(tmpdir(), 'git', ['clone', '-q', dir, planClone]);
      const followUpPlans = temporary('plans');
      const followUp = await planStacks({
        select: { cwd: planClone, base: followUpBase },
        directory: followUpPlans,
        runner: commandRunner(DEFAULT_COMMAND, planClone),
        concurrency: 1,
        createStacks: 'apply',
      });
      assert.deepEqual(followUp.failed, []);
      assert.deepEqual(
        followUp.stacks.map((stack) => stack.id),
        ['fresh/prod'],
      );
      const applyClone = temporary('apply-clone');
      run(tmpdir(), 'git', ['clone', '-q', dir, applyClone]);
      const applied = await apply(
        applyClone,
        followUpPlans,
        commandRunner(DEFAULT_COMMAND, applyClone),
      );
      assert.deepEqual(applied.stacks, [{ id: 'fresh/prod', outcome: 'applied' }]);
    });

    test('a new stack with resources fails planning, unless the change creates it when planning', async () => {
      const { dir, base, runner, plans } = setup();
      commit(dir, { 'Pulumi.prod.yaml': 'config: {}\n' });
      const manifest = await planStacks({
        select: { cwd: dir, base, run: ['words/prod'] },
        directory: plans,
        runner,
        concurrency: 1,
        createStacks: 'apply',
      });
      const prod = manifest.failed.find((stack) => stack.id === 'words/prod');
      assert.match(
        prod?.error ?? '',
        /must give it no resources; this one would create 1: random:index\/randomString:RandomString word/,
      );

      commit(dir, {}, 'Create it now\n\nPulumi-Affected-Create-Stacks: plan words/prod\n');
      const overridden = await planStacks({
        select: { cwd: dir, base, run: ['words/prod'] },
        directory: plans,
        runner,
        concurrency: 1,
        createStacks: 'apply',
      });
      const created = overridden.stacks.find((stack) => stack.id === 'words/prod');
      assert.equal(created?.created, true);
    });

    test('a new stack that reads another stack previews with that stack copied in', async () => {
      const { dir, runner, plans } = setup({
        'up/Pulumi.yaml': 'name: up\nruntime: yaml\noutputs:\n  zone: example.com\n',
        'up/Pulumi.dev.yaml': 'config: {}\n',
        'down/Pulumi.yaml': `name: down\nruntime: yaml\nresources:\n  ref:\n    type: pulumi:pulumi:StackReference\n    properties:\n      name: organization/up/dev\noutputs:\n  zone: \${ref.outputs["zone"]}\n`,
        'pulumi-affected.yaml': 'dependsOn:\n  down/*: [up/dev]\ncreateStacks:\n  default: apply\n',
      });
      deploy(dir, 'up');
      const base = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
      commit(dir, { 'down/Pulumi.dev.yaml': 'config: {}\n' });
      const manifest = await plan(dir, base, plans, runner);
      // The reference is a resource of its own; reading a stack isn't creating anything
      assert.deepEqual(
        manifest.failed.map((stack) => stack.error),
        [],
      );
      assert.deepEqual(
        manifest.stacks.map((stack) => [stack.id, stack.createOnApply]),
        [['down/dev', true]],
      );
    });
  });
});
