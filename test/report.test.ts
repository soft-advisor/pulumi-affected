import assert from 'node:assert/strict';
import test from 'node:test';
import { marker, syncComments } from '../src/action/comments.ts';
import { GitHubApi } from '../src/action/github.ts';
import { renderStackDetails, splitComments } from '../src/run/report.ts';
import type { StackRun } from '../src/run/runner.ts';
import { fakeApi } from './fake-api.ts';

const stack = {
  id: 'app/dev',
  project: 'app',
  dir: 'app',
  stack: 'dev',
  configFile: 'app/Pulumi.dev.yaml',
};

function runWithChanges(count: number): StackRun {
  const changes = Array.from({ length: count }, (_, index) => ({
    op: 'update',
    urn: `urn:pulumi:dev::app::aws:s3/bucket:Bucket::bucket-${index}`,
    type: 'aws:s3/bucket:Bucket',
    name: `bucket-${index}`,
    properties: ['tags'],
  }));
  return {
    stack,
    status: 'changes',
    reasons: ['app/index.ts: `bucket` changed'],
    classification: { changed: true, counts: { update: count }, changes, outputs: [], ignored: [] },
  };
}

test('a long report is split at stack boundaries, each part carrying its marker', () => {
  const sections = Array.from({ length: 5 }, () => renderStackDetails(runWithChanges(100)));
  const bodies = splitComments(
    '### Preview',
    'table',
    sections,
    (index) => marker('preview', index),
    20_000,
  );
  assert.ok(bodies.length > 1);
  bodies.forEach((body, index) => {
    assert.ok(body.startsWith(`<!-- pulumi-affected:preview:${index} -->`));
    assert.ok(body.length <= 20_000);
  });
  assert.equal(bodies.join('').split('<details>').length - 1, 5, 'no section is lost or cut');
});

test('a single stack too long for a comment is cut short with a link to the run', () => {
  const details = renderStackDetails(runWithChanges(5_000), 10_000, 'https://example.com/run');
  assert.ok(details.length <= 10_000);
  assert.match(
    details,
    /cut short; the full output is in the \[run\]\(https:\/\/example\.com\/run\)/,
  );
  assert.ok(details.endsWith('</details>'));
});

test('errors are fenced even when they contain backticks', () => {
  const details = renderStackDetails({
    stack,
    status: 'failed',
    reasons: [],
    error: 'error: ```bad```',
  });
  assert.match(details, /````\nerror: ```bad```\n````/);
});

test('names from the repository are escaped in comments', () => {
  const run = runWithChanges(1);
  const changes = run.classification?.changes ?? [];
  changes[0].name = '</code><img src=x onerror=alert(1)>`|';
  const details = renderStackDetails(run);
  assert.ok(!details.includes('<img'));
  assert.match(details, /<code>&lt;\/code&gt;&lt;img src=x onerror=alert\(1\)&gt;`&#124;<\/code>/);
});

test('comments are edited in place, added, and extras deleted', async () => {
  const api = await fakeApi({
    'GET /repos/acme/infra/issues/4/comments': [
      { id: 10, body: `${marker('preview', 0)}\nold`, user: { login: 'github-actions[bot]' } },
      { id: 11, body: `${marker('preview', 1)}\nold`, user: { login: 'github-actions[bot]' } },
      { id: 12, body: `${marker('preview', 2)}\nold`, user: { login: 'github-actions[bot]' } },
      { id: 13, body: 'unrelated', user: { login: 'someone' } },
      // Someone else's comment with the marker is never taken for the action's own
      { id: 14, body: `${marker('preview', 0)}\nspoofed`, user: { login: 'someone' } },
    ],
    'PATCH /repos/acme/infra/issues/comments/10': {},
    'DELETE /repos/acme/infra/issues/comments/11': '',
    'DELETE /repos/acme/infra/issues/comments/12': '',
  });
  process.env.GITHUB_API_URL = api.url;
  try {
    await syncComments(new GitHubApi('token', 'acme/infra'), 4, 'preview', [
      `${marker('preview', 0)}\nnew`,
    ]);
    const writes = api.calls
      .filter((call) => call.method !== 'GET')
      .map((call) => `${call.method} ${call.path}`);
    assert.deepEqual(writes, [
      'PATCH /repos/acme/infra/issues/comments/10',
      'DELETE /repos/acme/infra/issues/comments/11',
      'DELETE /repos/acme/infra/issues/comments/12',
    ]);
    assert.ok(!api.calls.some((call) => call.path.endsWith('/14')));
  } finally {
    api.close();
  }
});

test('with nothing to report and no earlier comment, nothing is posted', async () => {
  const api = await fakeApi({ 'GET /repos/acme/infra/issues/4/comments': [] });
  process.env.GITHUB_API_URL = api.url;
  try {
    await syncComments(new GitHubApi('token', 'acme/infra'), 4, 'preview', ['body'], true);
    assert.deepEqual(
      api.calls.filter((call) => call.method !== 'GET'),
      [],
    );
  } finally {
    api.close();
  }
});
