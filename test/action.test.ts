import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fakeApi } from './fake-api.ts';
import { commit, createRepo, project } from './helpers.ts';

const ACTION = join(import.meta.dirname, '../src/action/select.ts');

const PROJECTS = {
  ...project('alpha', 'alpha', ['dev'], { 'index.ts': 'export const a = 1;\n' }),
  ...project('beta', 'beta', ['dev'], { 'index.ts': 'export const b = 1;\n' }),
};

async function runAction(
  dir: string,
  eventName: string,
  payload: unknown,
  inputs: Record<string, string> = {},
  apiUrl = 'http://127.0.0.1:1',
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
    GITHUB_REPOSITORY: 'acme/infra',
    GITHUB_API_URL: apiUrl,
    'INPUT_GITHUB-TOKEN': 'token',
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  let stdout = '';
  try {
    stdout = (await promisify(execFile)('node', [ACTION], { cwd: dir, env })).stdout;
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
  const pattern = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const match of text.matchAll(pattern)) outputs[match[1]] = match[3];
  return outputs;
}

test('on a pull request, selects against the merge base and reads commands from writers', async () => {
  const { dir, base } = createRepo(PROJECTS);
  const head = commit(dir, { 'alpha/Pulumi.dev.yaml': 'config:\n  alpha:region: x\n' });
  const api = await fakeApi({
    'GET /repos/acme/infra/issues/7/comments': [
      { id: 1, body: '/pulumi-affected preview beta/dev', user: { login: 'maintainer' } },
      { id: 2, body: 'nice\n/pulumi-affected preview all', user: { login: 'stranger' } },
    ],
    'GET /repos/acme/infra/collaborators/maintainer/permission': {
      permission: 'write',
      role_name: 'write',
    },
    'GET /repos/acme/infra/collaborators/stranger/permission': {
      permission: 'read',
      role_name: 'read',
    },
    'POST /repos/acme/infra/issues/7/comments': {},
  });
  try {
    const { outputs, summary } = await runAction(
      dir,
      'pull_request',
      { pull_request: { number: 7, body: 'Changes', base: { sha: base }, head: { sha: head } } },
      {},
      api.url,
    );
    assert.deepEqual(JSON.parse(outputs.ids), ['alpha/dev', 'beta/dev']);
    assert.equal(outputs.any, 'true');
    assert.deepEqual(JSON.parse(outputs.waves), [['alpha/dev', 'beta/dev']]);
    const beta = JSON.parse(outputs.stacks).find(
      (stack: { id: string }) => stack.id === 'beta/dev',
    );
    assert.deepEqual(beta.reasons, [
      'requested by /pulumi-affected preview from @maintainer on #7',
    ]);
    assert.match(summary, /2 of 2 stacks selected/);

    const replies = api.calls.filter((call) => call.method === 'POST');
    assert.equal(replies.length, 1);
    assert.match(
      (replies[0].body as { body: string }).body,
      /pulumi-affected:ignored:2[\s\S]*@stranger only people with write access/,
    );
  } finally {
    api.close();
  }
});

test('on a push, compares with the previous commit and honours merged pull requests', async () => {
  const { dir, base } = createRepo(PROJECTS);
  const head = commit(dir, { 'README.md': 'docs\n' });
  const api = await fakeApi({
    [`GET /repos/acme/infra/commits/${head}/pulls`]: [
      {
        number: 3,
        body: 'Pulumi-Affected-Run: alpha/dev',
        base: { sha: base },
        head: { sha: head },
      },
    ],
    'GET /repos/acme/infra/issues/3/comments': [],
  });
  try {
    const { outputs } = await runAction(dir, 'push', { before: base }, {}, api.url);
    assert.deepEqual(JSON.parse(outputs.ids), ['alpha/dev']);
  } finally {
    api.close();
  }
});

test('the first push of a branch selects everything', async () => {
  const { dir } = createRepo(PROJECTS);
  const { outputs } = await runAction(
    dir,
    'push',
    { before: '0'.repeat(40) },
    { 'github-token': '' },
  );
  assert.deepEqual(JSON.parse(outputs.ids), ['alpha/dev', 'beta/dev']);
});

test('a comment that is not a command selects nothing', async () => {
  const { dir } = createRepo(PROJECTS);
  const { outputs, stdout } = await runAction(dir, 'issue_comment', {
    issue: { number: 1, pull_request: {} },
    comment: { id: 5, body: 'looks good', user: { login: 'someone' } },
  });
  assert.equal(outputs.any, 'false');
  assert.match(stdout, /Not a \/pulumi-affected command/);
});

test('without history for the merge base, the error says to fetch it', async () => {
  const { dir } = createRepo(PROJECTS);
  const { stdout } = await runAction(
    dir,
    'pull_request',
    { pull_request: { number: 1, body: '', base: { sha: 'f'.repeat(40) }, head: { sha: 'x' } } },
    { 'github-token': '' },
  );
  assert.match(stdout, /::error::Can't find the merge base .* fetch-depth: 0/);
});
