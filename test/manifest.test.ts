import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { marker } from '../src/action/comments.ts';
import { hashFile, type Manifest, readManifest, writeManifest } from '../src/plan/manifest.ts';
import { renderPlan } from '../src/plan/report.ts';

function manifestWith(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pulumi-affected-manifest-'));
  writeFileSync(join(directory, 'words__dev.plan.json'), '{}');
  const manifest: Manifest = {
    version: 1,
    tree: 'a'.repeat(40),
    head: 'b'.repeat(40),
    base: 'c'.repeat(40),
    pulumiVersion: 'v3.210.0',
    stacks: [
      {
        id: 'words/dev',
        project: 'words',
        dir: 'infra/words',
        stack: 'dev',
        wave: 0,
        state: { kind: 'exists', fingerprint: 'd'.repeat(64) },
        created: false,
        plan: 'words__dev.plan.json',
        preview: 'words__dev.preview.json',
        planHash: hashFile(join(directory, 'words__dev.plan.json')),
        counts: { update: 1 },
        changes: [
          {
            op: 'update',
            urn: 'urn',
            type: 'random:RandomString',
            name: '<img src=x>',
            properties: [],
          },
        ],
        keptForDependents: false,
        reasons: ['`lib/x.ts`: function `f` changed'],
        ...overrides,
      },
    ],
    unchanged: [],
    failed: [],
    skipped: [],
    dependencies: {},
    warnings: [],
  };
  writeManifest(directory, manifest);
  return { directory, manifest };
}

test('reads a manifest it wrote', () => {
  const { directory, manifest } = manifestWith();
  assert.deepEqual(readManifest(directory), manifest);
});

test('refuses manifests that point outside the repository or at other files', () => {
  for (const [overrides, pattern] of [
    [{ dir: '../elsewhere' }, /bad folder/],
    [{ dir: 'a/$(touch x)' }, /bad folder/],
    [{ stack: 'dev --yes', id: 'words/dev --yes' }, /bad name/],
    [{ plan: '../../etc/passwd' }, /unexpected file names/],
    [{ id: 'other/dev' }, /doesn't match/],
    [{ planHash: 'e'.repeat(64) }, /doesn't match its hash/],
    [{ state: { kind: 'exists' } }, /bad state/],
  ] as const) {
    const { directory } = manifestWith(overrides);
    assert.throws(() => readManifest(directory), pattern, JSON.stringify(overrides));
  }
});

test('escapes repository text in the plan comment', () => {
  const { manifest } = manifestWith();
  const { bodies } = renderPlan(manifest, (index) => marker('plan', index));
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].startsWith('<!-- pulumi-affected:plan:0 -->'));
  assert.ok(!bodies[0].includes('<img'));
  assert.match(bodies[0], /1 to apply/);
});
