import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runCommand } from '../src/run/index.ts';
import type { StackRun } from '../src/run/runner.ts';
import { commit, createRepo, type Files, run } from './helpers.ts';

/*
 * Runs real Pulumi against a local file backend. The programs are Pulumi YAML with the random
 * provider, so nothing needs installing besides the CLI and the provider plugin. Skipped when the
 * pulumi CLI isn't available.
 */

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The provider version CI installs ahead of time; see .github/workflows/ci.yml */
const RANDOM_VERSION = '4.21.6';

const pet = (name: string, keeper: string) => ({
  [`${name}/Pulumi.yaml`]: [
    `name: ${name}`,
    'runtime: yaml',
    'config:',
    '  keeper:',
    '    type: string',
    `    default: ${keeper}`,
    'resources:',
    '  pet:',
    '    type: random:RandomPet',
    '    properties:',
    '      keepers:',
    '        k: ${keeper}',
    // Pinned, so Pulumi never looks up the latest version (which shared CI runners get rate limited on)
    `    options:`,
    `      version: ${RANDOM_VERSION}`,
    'outputs:',
    '  name: ${pet.id}',
    '',
  ].join('\n'),
  [`${name}/Pulumi.dev.yaml`]: 'config: {}\n',
});

const consumer: Files = {
  'consumer/Pulumi.yaml': [
    'name: consumer',
    'runtime: yaml',
    'resources:',
    '  upstream:',
    '    type: pulumi:pulumi:StackReference',
    '    properties:',
    '      name: organization/base/dev',
    'outputs:',
    '  seen: ${upstream.outputs["name"]}',
    '',
  ].join('\n'),
  'consumer/Pulumi.dev.yaml': 'config: {}\n',
};

const FILES: Files = {
  ...pet('base', 'a'),
  ...pet('other', 'a'),
  ...consumer,
  // Analysis covers TypeScript; these YAML programs declare their dependency here
  'pulumi-affected.yaml': 'dependsOn:\n  consumer/dev: [base/dev]\n',
};

/** Statuses by stack, with any errors, so a failed assertion says what Pulumi said */
const statuses = (runs: StackRun[]) => {
  const errors = runs.filter((entry) => entry.error && entry.status !== 'skipped');
  if (errors.length > 0) {
    console.error(errors.map((entry) => `${entry.stack.id}: ${entry.error}`).join('\n'));
  }
  return Object.fromEntries(runs.map((entry) => [entry.stack.id, entry.status]));
};

describe('run with real Pulumi', { skip: !hasPulumi && 'the pulumi CLI is not installed' }, () => {
  let backend: string;
  const savedEnv = { ...process.env };

  before(() => {
    backend = mkdtempSync(join(tmpdir(), 'pulumi-affected-state-'));
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.PULUMI_CONFIG_PASSPHRASE = '';
    process.env.PULUMI_SKIP_UPDATE_CHECK = 'true';
  });
  after(() => {
    process.env = savedEnv;
    rmSync(backend, { recursive: true, force: true });
  });

  test('previews, deploys in waves, follows changed outputs and retries failures', {
    timeout: 600_000,
  }, async () => {
    const { dir, base } = createRepo(FILES);
    const options = { cwd: dir, base };

    // New stacks preview in a temporary backend and leave the real one untouched
    const preview = await runCommand({ ...options, mode: 'preview', all: true });
    assert.deepEqual(statuses(preview.runs), {
      'base/dev': 'changes',
      'consumer/dev': 'failed',
      'other/dev': 'changes',
    });
    assert.ok(preview.runs.every((entry) => entry.newStack || entry.status === 'failed'));
    assert.equal(run(dir, 'git', ['status', '--porcelain']), '', 'config files are restored');
    assert.doesNotMatch(run(dir, 'pulumi', ['stack', 'ls', '--all']), /base|other/);

    // Never-deployed stacks deploy, upstream first
    const first = await runCommand({ ...options, mode: 'up' });
    assert.deepEqual(statuses(first.runs), {
      'base/dev': 'changes',
      'other/dev': 'changes',
      'consumer/dev': 'changes',
    });
    assert.deepEqual(first.selection.waves, [['base/dev', 'other/dev'], ['consumer/dev']]);

    // Everything is deployed from HEAD, so nothing runs
    const idle = await runCommand({ ...options, mode: 'up' });
    assert.deepEqual(idle.runs, []);

    // A change to base replaces its pet; its output changes, so consumer deploys too
    commit(dir, {
      'base/Pulumi.yaml': FILES['base/Pulumi.yaml']?.replace('default: a', 'default: b') ?? '',
    });
    const changed = await runCommand({ ...options, mode: 'up' });
    assert.deepEqual(statuses(changed.runs), { 'base/dev': 'changes', 'consumer/dev': 'changes' });
    const consumerRun = changed.runs.find((entry) => entry.stack.id === 'consumer/dev');
    assert.deepEqual(consumerRun?.reasons, ['base/dev outputs changed: name']);
    assert.deepEqual(changed.runs[0].classification?.counts, { replace: 1 });

    // A failing deploy skips its dependents and is retried on the next run
    commit(dir, {
      'base/Pulumi.yaml': `${FILES['base/Pulumi.yaml']}  broken: \${nope}\n`,
      'other/Pulumi.dev.yaml': 'config: {other:keeper: c}\n',
    });
    const failing = await runCommand({ ...options, mode: 'up', run: ['consumer/dev'] });
    assert.deepEqual(statuses(failing.runs), {
      'base/dev': 'failed',
      'other/dev': 'changes',
      'consumer/dev': 'skipped',
    });
    // The failed stack runs again on the next push, even one that doesn't touch it
    commit(dir, { 'README.md': 'docs\n' });
    const retried = await runCommand({ ...options, mode: 'up' });
    assert.deepEqual(statuses(retried.runs), { 'base/dev': 'failed' });

    // Restoring what was last deployed successfully leaves nothing to do
    commit(dir, {
      'base/Pulumi.yaml': FILES['base/Pulumi.yaml']?.replace('default: a', 'default: b') ?? '',
    });
    const restored = await runCommand({ ...options, mode: 'up' });
    assert.deepEqual(restored.runs, []);
  });
});
