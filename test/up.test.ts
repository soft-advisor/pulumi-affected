import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readManifest, readPreviewSummary } from '../src/plan/manifest.ts';
import { planStacks } from '../src/plan/plan.ts';
import { type UpResult, upStacks } from '../src/plan/up.ts';
import { commandRunner, DEFAULT_COMMAND } from '../src/pulumi/runner.ts';
import { commit, createRepo, type Files, run } from './helpers.ts';

/*
 * Previewing on the pull request, then deploying with `pulumi up` (plan's mode preview, apply's
 * mode up), with the real Pulumi CLI against a local file backend. Skipped without Pulumi.
 */

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

/** `up` exports a word; `down` reads it through a stack reference; `other` is unrelated */
const upProgram = (word: string) => `name: up\nruntime: yaml\noutputs:\n  word: ${word}\n`;
const downProgram = (suffix: string) => `name: down
runtime: yaml
resources:
  ref:
    type: pulumi:pulumi:StackReference
    properties:
      name: organization/up/dev
outputs:
  word: \${ref.outputs["word"]}${suffix}
`;
const otherProgram = (comment: string) =>
  `name: other\nruntime: yaml\noutputs:\n  constant: same\n# ${comment}\n`;

function setup(extra: Files = {}) {
  process.env.PULUMI_BACKEND_URL = `file://${temporary('state')}`;
  const { dir } = createRepo({
    'up/Pulumi.yaml': upProgram('one'),
    'up/Pulumi.dev.yaml': 'config: {}\n',
    'down/Pulumi.yaml': downProgram(''),
    'down/Pulumi.dev.yaml': 'config: {}\n',
    'other/Pulumi.yaml': otherProgram('first'),
    'other/Pulumi.dev.yaml': 'config: {}\n',
    'pulumi-affected.yaml': 'dependsOn:\n  down/dev: [up/dev]\n',
    ...extra,
  });
  const runner = commandRunner(DEFAULT_COMMAND, dir);
  for (const folder of ['up', 'down', 'other']) {
    run(dir, 'pulumi', ['--non-interactive', '--cwd', folder, '--stack', 'dev', 'stack', 'init']);
    commit(dir, {}, 'salt');
    run(dir, 'pulumi', [
      '--non-interactive',
      '--cwd',
      folder,
      '--stack',
      'dev',
      'up',
      '--yes',
      '--skip-preview',
    ]);
  }
  const base = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
  return { dir, base, runner };
}

const outcomes = (result: UpResult) =>
  Object.fromEntries(result.stacks.map((stack) => [stack.id, stack.outcome]));

const output = (dir: string, folder: string) =>
  JSON.parse(
    run(dir, 'pulumi', [
      '--non-interactive',
      '--cwd',
      folder,
      '--stack',
      'dev',
      'stack',
      'output',
      '--json',
    ]),
  ).word;

describe('preview, then up', { skip: !hasPulumi && 'pulumi is not installed' }, () => {
  test('deploys what changed, skips what the preview found unchanged, and takes readers along', async () => {
    const { dir, base, runner } = setup();
    // up's output changes; other is selected but its preview shows nothing
    commit(dir, {
      'up/Pulumi.yaml': upProgram('two'),
      'other/Pulumi.yaml': otherProgram('second'),
    });

    const directory = temporary('previews');
    const manifest = await planStacks({
      select: { cwd: dir, base },
      directory,
      runner,
      concurrency: 2,
      mode: 'preview',
    });
    assert.equal(manifest.mode, 'preview');
    assert.deepEqual(
      manifest.stacks.map((stack) => stack.id),
      ['up/dev'],
    );
    assert.deepEqual(
      manifest.unchanged.map((stack) => stack.id),
      ['other/dev'],
    );
    // down is announced as deployed after up, not blocked
    assert.deepEqual(
      manifest.followUps.map((read) => [read.id, read.dependency]),
      [['down/dev', 'up/dev']],
    );
    assert.throws(() => readManifest(directory), /these are previews, not plans/);

    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      previews: readPreviewSummary(directory),
      outputReaders: 'up',
    });
    assert.deepEqual(outcomes(result), {
      'up/dev': 'applied',
      'down/dev': 'applied',
      'other/dev': 'unchanged',
    });
    assert.deepEqual(
      result.stacks.find((stack) => stack.id === 'down/dev')?.readsChanged?.[0]?.dependency,
      'up/dev',
    );
    assert.equal(output(dir, 'down'), 'two');
    assert.ok(result.ok);
  });

  test('with outputReaders warn, readers are only listed; without previews, every selected stack runs', async () => {
    const { dir, base, runner } = setup();
    commit(dir, {
      'up/Pulumi.yaml': upProgram('three'),
      'other/Pulumi.yaml': otherProgram('third'),
    });
    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      outputReaders: 'warn',
    });
    assert.deepEqual(outcomes(result), { 'up/dev': 'applied', 'other/dev': 'applied' });
    assert.deepEqual(
      result.followUps.map((read) => [read.id, read.dependency, read.outputs]),
      [['down/dev', 'up/dev', ['word']]],
    );
    assert.equal(output(dir, 'down'), 'one');
  });

  test('a new stack is created by up', async () => {
    const { dir, base, runner } = setup();
    commit(dir, { 'other/Pulumi.prod.yaml': 'config: {}\n' });
    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      outputReaders: 'up',
    });
    assert.deepEqual(outcomes(result), { 'other/prod': 'applied' });
  });

  test("a cycle elsewhere doesn't lose a reader; a reader deployed later isn't a follow-up", async () => {
    const { dir, base, runner } = setup({
      'pulumi-affected.yaml':
        'dependsOn:\n  down/dev: [up/dev]\n  other/dev: [other/prod]\n  other/prod: [other/dev]\n',
      'other/Pulumi.prod.yaml': 'config: {}\n',
    });
    commit(dir, { 'up/Pulumi.yaml': upProgram('four') });
    const taken = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      outputReaders: 'up',
    });
    assert.deepEqual(outcomes(taken), { 'up/dev': 'applied', 'down/dev': 'applied' });
    assert.equal(output(dir, 'down'), 'four');

    // Both selected, readers only listed: down still runs after up, so it isn't a follow-up
    const next = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'up/Pulumi.yaml': upProgram('five'), 'down/Pulumi.yaml': downProgram('!') });
    const listed = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base: next },
      outputReaders: 'warn',
    });
    assert.deepEqual(outcomes(listed), { 'up/dev': 'applied', 'down/dev': 'applied' });
    assert.deepEqual(listed.followUps, []);
    assert.equal(output(dir, 'down'), 'five!');
  });

  test('stacks outside the allow-list refuse the whole deploy', async () => {
    const { dir, base, runner } = setup();
    commit(dir, { 'up/Pulumi.yaml': upProgram('six'), 'other/Pulumi.yaml': otherProgram('sixth') });
    await assert.rejects(
      upStacks({
        cwd: dir,
        runner,
        concurrency: 2,
        select: { base },
        outputReaders: 'up',
        allow: ['other/*'],
      }),
      /up\/dev is selected but not among the stacks allowed/,
    );
    assert.equal(output(dir, 'up'), 'one');
  });

  test('a stack the preview found unchanged is deployed if it changed since', async () => {
    const { dir, base, runner } = setup();
    commit(dir, { 'other/Pulumi.yaml': otherProgram('previewed') });
    const previewed = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
    // Merged after the preview: other changes again
    commit(dir, {
      'other/Pulumi.yaml': 'name: other\nruntime: yaml\noutputs:\n  constant: same\n  added: yes\n',
    });
    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      previews: { changed: new Set(), unchanged: new Set(['other/dev']), head: previewed },
      outputReaders: 'up',
    });
    assert.deepEqual(outcomes(result), { 'other/dev': 'applied' });
  });

  test('the preview is trusted when the merged code is the previewed code, even if its commit is unreachable', async () => {
    const { dir, base, runner } = setup();
    commit(dir, {
      'up/Pulumi.yaml': upProgram('seven'),
      'other/Pulumi.yaml': otherProgram('seventh'),
    });
    const tree = run(dir, 'git', ['rev-parse', 'HEAD^{tree}']).trim();
    // GitHub's merge commit for the pull request: on no branch, so not in the checkout
    const unreachable = 'f'.repeat(40);
    const trusted = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      previews: {
        changed: new Set(['up/dev']),
        unchanged: new Set(['other/dev']),
        head: unreachable,
        tree,
      },
      outputReaders: 'warn',
    });
    assert.equal(outcomes(trusted)['other/dev'], 'unchanged');
    assert.deepEqual(trusted.warnings, []);

    // Different code and no way to compare: everything selected is deployed, and it says why
    const distrusted = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      previews: {
        changed: new Set(['up/dev']),
        unchanged: new Set(['other/dev']),
        head: unreachable,
        tree: 'e'.repeat(40),
      },
      outputReaders: 'warn',
      fetchCommit: () => false,
    });
    assert.equal(outcomes(distrusted)['other/dev'], 'applied');
    assert.match(
      distrusted.warnings.join('\n'),
      /can't be compared with this one.*other\/dev included/,
    );
  });

  test('a dependsOn that names outputs deploys the dependent only when those change', async () => {
    const { dir, base, runner } = setup({
      'pulumi-affected.yaml': 'dependsOn:\n  down/dev:\n    up/dev: [zone]\n',
    });
    // up's word changes, but down only depends on up's zone
    commit(dir, { 'up/Pulumi.yaml': upProgram('eight') });
    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      outputReaders: 'up',
    });
    assert.deepEqual(outcomes(result), { 'up/dev': 'applied' });
    assert.deepEqual(result.followUps, []);
  });

  test("outputs dependsOn names that a stack doesn't export are reported, when previewing and deploying", async () => {
    const { dir, base, runner } = setup({
      'pulumi-affected.yaml': 'dependsOn:\n  down/dev:\n    up/dev: [wrod]\n',
    });
    commit(dir, { 'up/Pulumi.yaml': upProgram('nine') });
    const directory = temporary('previews');
    const manifest = await planStacks({
      select: { cwd: dir, base },
      directory,
      runner,
      concurrency: 2,
      mode: 'preview',
    });
    assert.match(
      manifest.warnings.join('\n'),
      /dependsOn says down\/dev reads "wrod" of up\/dev, which it doesn't export \(it exports word\)/,
    );
    const result = await upStacks({
      cwd: dir,
      runner,
      concurrency: 2,
      select: { base },
      outputReaders: 'up',
    });
    assert.match(result.warnings.join('\n'), /reads "wrod" of up\/dev, which it doesn't export/);
  });
});
