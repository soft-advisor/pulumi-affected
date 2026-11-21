import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { commit, createRepo, project } from './helpers.ts';

const SELECT = join(import.meta.dirname, '../src/action/select.ts');
const CLASSIFY = join(import.meta.dirname, '../src/action/classify.ts');

const PROJECTS = {
  ...project('alpha', 'alpha', ['dev'], { 'index.ts': 'export const a = 1;\n' }),
  ...project('beta', 'beta', ['dev'], { 'index.ts': 'export const b = 1;\n' }),
};

async function runAction(
  action: string,
  dir: string,
  eventName: string,
  payload: unknown,
  inputs: Record<string, string> = {},
) {
  const temp = mkdtempSync(join(tmpdir(), 'pulumi-affected-action-'));
  const eventPath = join(temp, 'event.json');
  const outputPath = join(temp, 'output');
  const summaryPath = join(temp, 'summary');
  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  let stdout = '';
  try {
    stdout = (await promisify(execFile)('node', [action], { cwd: dir, env })).stdout;
  } catch (error) {
    stdout = (error as { stdout: string }).stdout;
  }
  return {
    outputs: parseOutputs(readFileSync(outputPath, 'utf8')),
    summary: readFileSync(summaryPath, 'utf8'),
    stdout,
  };
}

function parseOutputs(text: string) {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[match[1]] = match[3];
  }
  return outputs;
}

test('select on a pull request compares with the merge base and honours its description', async () => {
  const { dir, base } = createRepo(PROJECTS);
  const head = commit(dir, { 'alpha/Pulumi.dev.yaml': 'config:\n  alpha:region: x\n' });
  const { outputs, summary } = await runAction(
    SELECT,
    dir,
    'pull_request',
    {
      pull_request: {
        body: 'Pulumi-Affected-Run: beta/dev',
        base: { sha: base },
        head: { sha: head },
      },
    },
    { 'output-file': 'selection.json' },
  );
  assert.deepEqual(JSON.parse(outputs.ids), ['alpha/dev', 'beta/dev']);
  assert.equal(outputs.any, 'true');
  assert.match(summary, /2 of 2 stacks selected/);
  const file = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8'));
  assert.deepEqual(
    file.stacks.map((stack: { id: string }) => stack.id),
    ['alpha/dev', 'beta/dev'],
  );
});

test('select on a push compares with the previous commit, and a new branch selects everything', async () => {
  const { dir, base } = createRepo(PROJECTS);
  commit(dir, { 'beta/index.ts': 'export const b = 2;\n' });
  const push = await runAction(SELECT, dir, 'push', { before: base });
  assert.deepEqual(JSON.parse(push.outputs.ids), ['beta/dev']);
  const branch = await runAction(SELECT, dir, 'push', { before: '0'.repeat(40) });
  assert.deepEqual(JSON.parse(branch.outputs.ids), ['alpha/dev', 'beta/dev']);
});

test('without history for the merge base, the error says to fetch it', async () => {
  const { dir } = createRepo(PROJECTS);
  const { stdout } = await runAction(SELECT, dir, 'pull_request', {
    pull_request: { body: '', base: { sha: 'f'.repeat(40) } },
  });
  assert.match(stdout, /::error::Can't find the merge base .* fetch-depth: 0/);
});

test('classify sorts previews into those with changes and those without', async () => {
  const { dir } = createRepo({
    ...PROJECTS,
    'pulumi-affected.yaml':
      'classify:\n  ignore:\n    - type: pulumi:providers:aws\n      properties: [assumeRole]\n',
  });
  mkdirSync(join(dir, 'plans'));
  const step = (op: string, type = 't', diffReasons: string[] = []) => ({
    op,
    urn: `urn:pulumi:dev::p::${type}::r`,
    newState: { type },
    diffReasons,
  });
  writeFileSync(join(dir, 'plans/a.preview.json'), JSON.stringify({ steps: [step('create')] }));
  writeFileSync(join(dir, 'plans/b.preview.json'), JSON.stringify({ steps: [step('same')] }));
  writeFileSync(
    join(dir, 'plans/c.preview.json'),
    JSON.stringify({ steps: [step('update', 'pulumi:providers:aws', ['assumeRole'])] }),
  );
  const { outputs, summary } = await runAction(
    CLASSIFY,
    dir,
    'pull_request',
    {},
    { previews: 'plans/*.preview.json' },
  );
  assert.deepEqual(JSON.parse(outputs.changed), ['plans/a.preview.json']);
  assert.deepEqual(JSON.parse(outputs.unchanged), ['plans/b.preview.json', 'plans/c.preview.json']);
  assert.match(summary, /1 of 3 would change/);
});
