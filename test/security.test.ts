import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { eventContext } from '../src/action/context.ts';
import { classify } from '../src/classify.ts';
import { defaultConfig, parseConfig } from '../src/config.ts';
import { discoverProjects } from '../src/projects.ts';
import { renderMarkdown } from '../src/render.ts';
import { select } from '../src/select.ts';
import { WorktreeSnapshot } from '../src/snapshot.ts';
import { commit, createRepo, project, run, write } from './helpers.ts';

test('names that are not valid Pulumi names are skipped with a warning', () => {
  const { dir } = createRepo({
    ...project('app', 'app', ['dev']),
    'app/Pulumi.$(touch pwned).yaml': 'config: {}\n',
    '$(evil)/Pulumi.yaml': 'name: evil\nruntime: nodejs\n',
    'other/Pulumi.yaml': 'name: "a b"\nruntime: nodejs\n',
  });
  const warnings: string[] = [];
  const projects = discoverProjects(new WorktreeSnapshot(dir), defaultConfig(), warnings);
  assert.deepEqual(
    projects.flatMap((p) => p.stacks.map((s) => s.id)),
    ['app/dev'],
  );
  assert.equal(warnings.length, 3);
});

test('stacks listed in the config must have valid names', () => {
  const { dir } = createRepo(project('app', 'app', ['dev']));
  const warnings: string[] = [];
  const config = parseConfig('stacks: ["app/ok", "app/dev.x"]\n');
  config.stacks.push('app/bad$(id)');
  const projects = discoverProjects(new WorktreeSnapshot(dir), config, warnings);
  assert.deepEqual(
    projects[0].stacks.map((stack) => stack.stack),
    ['dev', 'dev.x', 'ok'],
  );
  assert.match(warnings[0], /isn't a valid Pulumi stack name/);
  assert.throws(() => parseConfig('stacks: ["app/bad$(id)"]\n'), /invalid/);
});

test('a symbolic link reads as its target path, as git stores it', () => {
  const { dir } = createRepo(project('', 'app', ['dev']));
  symlinkSync('/etc/hosts', join(dir, 'pulumi-affected.yaml'));
  const snapshot = new WorktreeSnapshot(dir);
  assert.equal(snapshot.read('pulumi-affected.yaml'), '/etc/hosts');
  write(dir, { 'pulumi-affected.yaml': null });
  run(dir, 'git', ['status', '--porcelain']);
});

test('the summary escapes everything Markdown acts on in names from the repository', () => {
  const { dir, base } = createRepo(
    project('app', 'app', ['dev'], { 'index.ts': 'export const a = 1;\n' }),
  );
  const head = commit(
    dir,
    { 'app/index.ts': 'export const a = 2;\n' },
    'x\n\nPulumi-Affected-Skip: [a](https://evil) @team',
  );
  const markdown = renderMarkdown(select({ cwd: dir, base, head, run: ['app/dev'] }));
  assert.ok(!markdown.includes('[a](https://evil)'));
  assert.ok(!markdown.includes('@team'));
});

test('skipped stacks are listed with who skipped them', () => {
  const { dir, base } = createRepo(
    project('', 'app', ['dev'], { 'index.ts': 'export const a = 1;\n' }),
  );
  const head = commit(
    dir,
    { 'index.ts': 'export const a = 2;\n' },
    'change\n\nPulumi-Affected-Skip: all',
  );
  const result = select({ cwd: dir, base, head });
  assert.deepEqual(result.stacks, []);
  assert.deepEqual(
    result.skipped.map((skip) => skip.id),
    ['app/dev'],
  );
  assert.match(result.skipped[0].source, /^commit [0-9a-f]+$/);
});

test('a pull request compares with its merge base; a force push warns', () => {
  const { dir, base } = createRepo(project('', 'app', ['dev']));
  commit(dir, { 'index.ts': 'export const a = 1;\n' });
  const context = eventContext(
    { name: 'pull_request', payload: { pull_request: { body: 'hi', base: { sha: base } } } },
    dir,
  );
  assert.equal(context.base, base);
  assert.deepEqual(context.messages, ['hi']);
  const forced = eventContext({ name: 'push', payload: { before: 'f'.repeat(40) } }, dir);
  assert.equal(forced.base, undefined);
  assert.match(forced.warnings[0], /isn't available/);
});

test('preview output past a wrapper banner with braces or JSON of its own is read', () => {
  const plan = JSON.stringify({ steps: [{ op: 'create', urn: 'urn:pulumi:s::p::t::r' }] });
  const output = `Assuming role {deploy}\n{"Account": "123", "Arn": "x"}\n${plan}\n`;
  assert.deepEqual(classify(output).counts, { create: 1 });
});
