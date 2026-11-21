import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Stack } from '../src/projects.ts';
import {
  type CommandResult,
  deployHistory,
  type PulumiRunner,
  upStack,
} from '../src/run/pulumi.ts';
import { renderStackDetails } from '../src/run/report.ts';
import { createRepo, project } from './helpers.ts';

const stack: Stack = {
  id: 'p/dev',
  project: 'p',
  dir: 'p',
  stack: 'dev',
  configFile: 'p/Pulumi.dev.yaml',
};

function runnerFor(answer: (args: string[]) => CommandResult): PulumiRunner {
  return {
    run: async (_stack, args) => answer(args),
    runPulumi: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

const missing: CommandResult = {
  code: 255,
  stdout: '',
  stderr: "error: no stack named 'dev' found",
};

test('a deploy never re-creates a stack whose config shows it was created before', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pulumi-affected-up-'));
  mkdirSync(join(repo, 'p'));
  writeFileSync(join(repo, 'p/Pulumi.dev.yaml'), 'encryptionsalt: v1:abc\nconfig: {}\n');
  let initialised = false;
  const runner = runnerFor((args) => {
    if (args[1] === 'init') initialised = true;
    return missing;
  });
  const outcome = await upStack(runner, stack, repo, []);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /likely the wrong backend/);
  assert.equal(initialised, false);

  writeFileSync(join(repo, 'p/Pulumi.dev.yaml'), 'config: {}\n');
  const refused = await upStack(runner, stack, repo, [], false);
  assert.match(refused.kind === 'failed' ? refused.error : '', /run.createStacks is false/);
});

test('partial deploys, imports, failed destroys and endless history are unknown', async () => {
  const history = (entries: unknown[]) =>
    runnerFor((args) => {
      const page = Number(args[args.indexOf('--page') + 1]);
      return { code: 0, stdout: JSON.stringify(page === 1 ? entries : []), stderr: '' };
    });
  const head = 'a'.repeat(40);
  const update = (environment: Record<string, string>) => ({
    kind: 'update',
    result: 'succeeded',
    environment: { 'git.head': head, ...environment },
  });
  assert.deepEqual(await deployHistory(history([update({})]), stack), {
    kind: 'commit',
    sha: head,
    lastFailed: false,
    dirty: false,
  });
  for (const flag of ['target', 'exclude', 'target-replace']) {
    const result = await deployHistory(
      history([update({ [`pulumi.flag.${flag}`]: 'set' })]),
      stack,
    );
    assert.equal(result.kind, 'unknown', flag);
  }
  assert.equal(
    (await deployHistory(history([{ kind: 'import', result: 'succeeded' }, update({})]), stack))
      .kind,
    'unknown',
  );
  assert.equal(
    (await deployHistory(history([{ kind: 'destroy', result: 'failed' }, update({})]), stack)).kind,
    'unknown',
  );
  const endless = runnerFor(() => ({
    code: 0,
    stdout: JSON.stringify([{ kind: 'refresh', result: 'succeeded' }]),
    stderr: '',
  }));
  assert.equal((await deployHistory(endless, stack)).kind, 'unknown');
  assert.deepEqual(await deployHistory(history([{ kind: 'update', result: 'failed' }]), stack), {
    kind: 'never',
  });
});

test('a cut-short error keeps its code fence closed', () => {
  const details = renderStackDetails(
    { stack, status: 'failed', reasons: [], error: 'x'.repeat(20_000) },
    5_000,
  );
  assert.ok(details.length <= 5_000);
  assert.equal(details.match(/^`{3,}$/gm)?.length, 2, 'the fence opens and closes');
  assert.match(details, /`\n\n…cut short[^`]*<\/details>$/);
});

test('cancelling forwards an interrupt to Pulumi and restores what a new-stack preview changed', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'pulumi-affected-bin-'));
  const marker = join(bin, 'interrupted');
  // A pulumi that reports the stack missing, writes a salt on init, and waits in preview
  writeFileSync(
    join(bin, 'pulumi'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"stack output"*) echo "error: no stack named 'dev' found" >&2; exit 255 ;;`,
      '  *"stack init"*) printf "encryptionsalt: v1:x\\n" >> "$2/Pulumi.dev.yaml"; exit 0 ;;',
      `  *preview*) trap 'touch ${marker}; exit 130' INT; sleep 30 & wait ;;`,
      'esac',
    ].join('\n'),
  );
  chmodSync(join(bin, 'pulumi'), 0o755);
  const { dir, base } = createRepo(
    project('p', 'p', ['dev'], { 'index.ts': 'export const a = 1;\n' }),
  );
  const config = readFileSync(join(dir, 'p/Pulumi.dev.yaml'), 'utf8');
  const cli = spawn(
    'node',
    [
      join(import.meta.dirname, '../src/cli.ts'),
      'run',
      '--mode',
      'preview',
      '--base',
      base,
      '--all',
    ],
    { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' },
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  cli.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
  assert.equal(code, 143);
  assert.ok(existsSync(marker), 'pulumi got SIGINT');
  assert.equal(
    readFileSync(join(dir, 'p/Pulumi.dev.yaml'), 'utf8'),
    config,
    'the config file is restored',
  );
});

test('the CLI refuses a concurrency below 1', async () => {
  const { dir, base } = createRepo(project('p', 'p', ['dev']));
  const cli = spawn(
    'node',
    [
      join(import.meta.dirname, '../src/cli.ts'),
      'run',
      '--mode',
      'preview',
      '--base',
      base,
      '--concurrency',
      '0',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  assert.equal(await new Promise((resolve) => cli.on('close', resolve)), 2);
});
