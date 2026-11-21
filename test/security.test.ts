import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { eventContext } from '../src/action/context.ts';
import { GitHubApi } from '../src/action/github.ts';
import { discoverProjects } from '../src/projects.ts';
import { defaultConfig } from '../src/config.ts';
import { childEnvironment, errorText, expandTemplate } from '../src/run/pulumi.ts';
import { WorktreeSnapshot } from '../src/snapshot.ts';
import { fakeApi } from './fake-api.ts';
import { commit, createRepo, project, run, write } from './helpers.ts';

const REPO = { full_name: 'acme/infra' };
const FORK = { full_name: 'stranger/infra' };

async function withApi<T>(routes: Record<string, unknown>, body: (api: GitHubApi) => Promise<T>) {
  const server = await fakeApi(routes);
  process.env.GITHUB_API_URL = server.url;
  try {
    return await body(new GitHubApi('token', 'acme/infra'));
  } finally {
    server.close();
  }
}

function pullRequest(head: string, base: string, headRepo = REPO) {
  return {
    number: 7,
    body: '',
    base: { sha: base, ref: 'main', repo: REPO },
    head: { sha: head, repo: headRepo },
  };
}

function commentEvent(login: string, action = 'created') {
  return {
    name: 'issue_comment',
    payload: {
      action,
      issue: { number: 7, pull_request: {} },
      comment: { id: 1, body: '/pulumi-affected preview all', user: { login } },
    },
  };
}

test('a comment command from someone without write access runs nothing', async () => {
  const { dir } = createRepo(project('', 'app', ['dev']));
  const context = await withApi(
    { 'GET /repos/acme/infra/collaborators/stranger/permission': { permission: 'read' } },
    (api) => eventContext(commentEvent('stranger'), dir, api),
  );
  assert.equal(context, undefined);
});

test('edited comments are not commands', async () => {
  const { dir } = createRepo(project('', 'app', ['dev']));
  const context = await withApi({}, (api) =>
    eventContext(commentEvent('maintainer', 'edited'), dir, api),
  );
  assert.equal(context, undefined);
});

test("a writer's command on a fork's pull request is refused", async () => {
  const { dir, base } = createRepo(project('', 'app', ['dev']));
  const head = commit(dir, { 'index.ts': 'export const a = 1;\n' });
  await assert.rejects(
    withApi(
      {
        'GET /repos/acme/infra/collaborators/maintainer/permission': { permission: 'write' },
        'GET /repos/acme/infra/pulls/7': pullRequest(head, base, FORK),
      },
      (api) => eventContext(commentEvent('maintainer'), dir, api),
    ),
    /Commands don't run on pull requests from forks/,
  );
});

test("a writer's command on a pull request in the repository runs, and its patterns count", async () => {
  const { dir, base } = createRepo(project('', 'app', ['dev']));
  const head = commit(dir, { 'index.ts': 'export const a = 1;\n' });
  const context = await withApi(
    {
      // A custom role built on write still has the write base permission
      'GET /repos/acme/infra/collaborators/maintainer/permission': {
        permission: 'write',
        role_name: 'deployer',
      },
      'GET /repos/acme/infra/pulls/7': pullRequest(head, base),
      'GET /repos/acme/infra/issues/7/comments': [
        {
          id: 1,
          body: 'Please check\n/pulumi-affected preview app/dev',
          user: { login: 'maintainer' },
        },
        // The action's own comments never count as commands, even when they quote one
        {
          id: 2,
          body: '<!-- pulumi-affected:preview:0 -->\n/pulumi-affected preview all',
          user: { login: 'maintainer' },
        },
      ],
    },
    (api) => eventContext(commentEvent('maintainer'), dir, api),
  );
  assert.deepEqual(context?.requests, [
    { pattern: 'app/dev', source: '/pulumi-affected preview from @maintainer on #7' },
  ]);
});

test("pull_request_target refuses to run a fork's checked-out code", async () => {
  const { dir, base } = createRepo(project('', 'app', ['dev']));
  const head = commit(dir, { 'index.ts': 'export const a = 1;\n' });
  await assert.rejects(
    eventContext(
      { name: 'pull_request_target', payload: { pull_request: pullRequest(head, base, FORK) } },
      dir,
      undefined,
    ),
    /use pull_request/,
  );
});

test('a push only takes requests from pull requests merged into the pushed branch', async () => {
  const { dir, base } = createRepo(project('', 'app', ['dev']));
  const head = commit(dir, { 'index.ts': 'export const a = 1;\n' });
  const context = await withApi(
    {
      [`GET /repos/acme/infra/commits/${head}/pulls`]: [
        {
          ...pullRequest(head, base),
          number: 3,
          body: 'Pulumi-Affected-Run: all',
          merged_at: null,
        },
        {
          ...pullRequest(head, base),
          number: 4,
          body: 'merged',
          merged_at: '2026-01-01T00:00:00Z',
        },
      ],
      'GET /repos/acme/infra/issues/4/comments': [],
    },
    (api) =>
      eventContext({ name: 'push', payload: { before: base, ref: 'refs/heads/main' } }, dir, api),
  );
  assert.deepEqual(context?.messages, ['merged']);
  assert.deepEqual(
    context?.mergedPullRequests.map((pr) => pr.number),
    [4],
  );
});

test('a force push whose previous commit is gone warns instead of failing', async () => {
  const { dir } = createRepo(project('', 'app', ['dev']));
  const context = await eventContext(
    { name: 'push', payload: { before: 'f'.repeat(40), ref: 'refs/heads/main' } },
    dir,
    undefined,
  );
  assert.equal(context?.base, undefined);
  assert.match(context?.warnings[0] ?? '', /isn't available/);
});

test('Pulumi runs without the job token, runtime tokens, step files or OIDC variables', () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    'INPUT_GITHUB-TOKEN': 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com',
    GITHUB_ENV: '/tmp/env',
    GITHUB_PATH: '/tmp/path',
    GITHUB_REPOSITORY: 'acme/infra',
    AWS_ACCESS_KEY_ID: 'kept',
  });
  try {
    const env = childEnvironment({});
    for (const name of [
      'INPUT_GITHUB-TOKEN',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_ENV',
      'GITHUB_PATH',
    ]) {
      assert.equal(env[name], undefined, name);
    }
    assert.equal(env.GITHUB_REPOSITORY, 'acme/infra');
    assert.equal(env.AWS_ACCESS_KEY_ID, 'kept');
    assert.equal(childEnvironment({ passOidc: true }).ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'secret');
  } finally {
    process.env = saved;
  }
});

test('names that are not valid Pulumi names never reach a command', () => {
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
  assert.equal(
    expandTemplate('scripts/pulumi.sh {stack} --cwd {dir}', {
      ...projects[0].stacks[0],
      dir: 'my app',
    }),
    "scripts/pulumi.sh dev --cwd 'my app'",
  );
});

test('error reports carry diagnostics, not the resource values in the JSON output', () => {
  const plan = JSON.stringify({
    steps: [{ op: 'update', urn: 'u', newState: { outputs: { password: 'hunter2' } } }],
  });
  const events = [
    JSON.stringify({
      sequence: 1,
      resourcePreEvent: { metadata: { new: { outputs: { token: 'hunter2' } } } },
    }),
    JSON.stringify({
      sequence: 2,
      diagnosticEvent: { severity: 'error', message: 'error: update failed' },
    }),
  ].join('\n');
  const text = errorText({ code: 255, stdout: `${plan}\n${events}\n`, stderr: '' });
  assert.equal(text, 'error: update failed');
  const noDiagnostics = errorText({ code: 255, stdout: `${plan}\n`, stderr: 'boom\n' });
  assert.ok(!noDiagnostics.includes('hunter2'));
});

test('a symbolic link reads as its target path, as git stores it', () => {
  const { dir } = createRepo(project('', 'app', ['dev']));
  symlinkSync('/etc/hosts', join(dir, 'pulumi-affected.yaml'));
  const snapshot = new WorktreeSnapshot(dir);
  assert.equal(snapshot.read('pulumi-affected.yaml'), '/etc/hosts');
  write(dir, { 'pulumi-affected.yaml': null });
  run(dir, 'git', ['status', '--porcelain']);
});
