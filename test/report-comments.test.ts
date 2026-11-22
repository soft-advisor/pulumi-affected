import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Comment, marker, postReport } from '../src/action/comments.ts';
import type { GitHubApi } from '../src/action/github.ts';
import { ensureCurrentMerge } from '../src/action/merge.ts';
import { commit, createRepo, run } from './helpers.ts';

/** A pull request's comments, kept in memory, behind the calls postReport makes */
function fakeApi() {
  let next = 1;
  const comments: (Comment & { minimized?: boolean })[] = [];
  const api = {
    repository: 'acme/infra',
    repo: (path: string) => `/repos/acme/infra${path}`,
    ownComments: async () => (author: { login: string } | null) => author?.login === 'bot',
    list: async () => comments.map((comment) => ({ ...comment })),
    graphql: async (_query: string, { id }: { id: string }) => {
      const comment = comments.find((candidate) => candidate.node_id === id);
      if (comment) comment.minimized = true;
    },
    request: async (method: string, path: string, body?: { body: string }) => {
      const id = Number(path.split('/').pop());
      if (method === 'POST') {
        comments.push({
          id: next,
          node_id: `node${next++}`,
          body: body?.body,
          user: { login: 'bot' },
        });
      } else if (method === 'PATCH') {
        const comment = comments.find((candidate) => candidate.id === id);
        if (comment) comment.body = body?.body;
      } else if (method === 'DELETE') {
        comments.splice(
          comments.findIndex((candidate) => candidate.id === id),
          1,
        );
      }
    },
  };
  return { api: api as unknown as GitHubApi, comments };
}

const report = (text: string, footer = 'abc') => [
  `${marker('plan', 0)}\n### pulumi-affected preview: ${text}\n\nbody\n\n<sub>Previewed ${footer}</sub>`,
];
const status = (sha: string) => ({
  verb: 'Previewed',
  sha,
  url: `https://github.com/acme/infra/pull/1/commits/${sha}`,
});

test('a report is posted again only when its results change', async () => {
  const { api, comments } = fakeApi();
  await postReport(api, 1, 'plan', report('1 with changes', 'aaa'), status('a'.repeat(40)));
  assert.equal(comments.length, 1);
  assert.match(
    comments[0].body ?? '',
    /\nPreviewed against \[aaaaaaa\]\(https:\/\/github.com\/acme\/infra\/pull\/1\/commits\/a{40}\)\.\n/,
  );

  // Same results, another commit: updated in place, saying so
  await postReport(api, 1, 'plan', report('1 with changes', 'bbb'), status('b'.repeat(40)));
  assert.equal(comments.length, 1);
  assert.match(comments[0].body ?? '', /Previewed again against \[bbbbbbb\]\(.*\), no change\./);

  // Different results: the old one is hidden and marked outdated, and a new one posted
  await postReport(api, 1, 'plan', report('2 with changes'), status('c'.repeat(40)));
  assert.equal(comments.length, 2);
  assert.ok(comments[0].minimized);
  assert.ok(comments[0].body?.startsWith('<!-- pulumi-affected:plan-outdated:0 -->'));
  assert.match(
    comments[1].body ?? '',
    /^<!-- pulumi-affected:plan:0 -->[\s\S]*Previewed against \[ccccccc\]/,
  );
});

test("a checkout of GitHub's merge into an old base is replaced by the new merge", async () => {
  const { dir } = createRepo({ 'a.txt': 'a\n' });
  const oldBase = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
  run(dir, 'git', ['checkout', '-q', '-b', 'feature']);
  const head = commit(dir, { 'b.txt': 'b\n' });
  run(dir, 'git', ['checkout', '-q', '-b', 'main2', oldBase]);
  const newBase = commit(dir, { 'c.txt': 'c\n' });
  // GitHub's stale merge (into the old base), checked out, and its newer one
  run(dir, 'git', ['checkout', '-q', '--detach', oldBase]);
  run(dir, 'git', ['merge', '-q', '--no-ff', '--no-edit', head]);
  const stale = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
  run(dir, 'git', ['checkout', '-q', '--detach', newBase]);
  run(dir, 'git', ['merge', '-q', '--no-ff', '--no-edit', head]);
  const fresh = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
  run(dir, 'git', ['checkout', '-q', '--detach', stale]);

  const event = {
    name: 'pull_request',
    payload: { pull_request: { number: 1, base: { sha: newBase } } },
  };
  let polls = 0;
  const api = {
    repo: (path: string) => path,
    request: async () => {
      polls++;
      // Still computing on the first look
      return polls === 1
        ? { mergeable: null, merge_commit_sha: stale, base: { sha: newBase } }
        : { mergeable: true, merge_commit_sha: fresh, base: { sha: newBase } };
    },
  } as unknown as GitHubApi;
  const result = await ensureCurrentMerge(dir, event, api, 'token', async () => {});
  assert.deepEqual(result, { kind: 'refreshed', sha: fresh });
  assert.equal(run(dir, 'git', ['rev-parse', 'HEAD']).trim(), fresh);

  // Already current: nothing to do
  assert.deepEqual(await ensureCurrentMerge(dir, event, api, 'token', async () => {}), {
    kind: 'current',
  });
});
