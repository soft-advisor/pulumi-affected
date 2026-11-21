import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { marker } from '../src/action/comments.ts';
import { splitComments } from '../src/action/split.ts';
import { hashFile, type Manifest, readManifest, writeManifest } from '../src/plan/manifest.ts';
import { relaxPlan, stackOutputChanges, UNKNOWN } from '../src/plan/planfile.ts';
import { renderPlan } from '../src/plan/report.ts';

function manifestWith(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pulumi-affected-manifest-'));
  writeFileSync(join(directory, 'words+dev.plan.json'), '{}');
  const manifest: Manifest = {
    version: 2,
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
        fingerprint: 'd'.repeat(64),
        created: false,
        plan: 'words+dev.plan.json',
        preview: 'words+dev.preview.json',
        planHash: hashFile(join(directory, 'words+dev.plan.json')),
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
        outputs: [],
        reasons: ['`lib/x.ts`: function `f` changed'],
        ...overrides,
      },
    ],
    unchanged: [],
    failed: [],
    skipped: [],
    followUps: [],
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
    [{ dir: '/etc' }, /bad folder/],
    [{ dir: 'a\\b' }, /bad folder/],
    [{ stack: 'dev --yes', id: 'words/dev --yes' }, /bad name/],
    [{ plan: '../../etc/passwd' }, /unexpected file names/],
    [{ id: 'other/dev' }, /doesn't match/],
    [{ planHash: 'e'.repeat(64) }, /doesn't match its hash/],
    [{ fingerprint: undefined }, /bad fingerprint/],
    [{ encryptionSalt: 'v1:x\nconfig: {}' }, /bad encryption salt/],
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

test('cuts a section too long for any comment', () => {
  const huge = `<details><summary>x</summary>\n\n\`\`\`\n${'e'.repeat(100_000)}\n\`\`\`\n\n</details>`;
  const bodies = splitComments('### heading', 'intro', [huge], (index) => marker('plan', index));
  for (const body of bodies) assert.ok(body.length < 65_536, `${body.length} characters`);
  assert.match(bodies.at(-1) ?? '', /cut short[\s\S]*```[\s\S]*<\/details>$/);
});

const plan = JSON.stringify({
  resourcePlans: {
    'urn:pulumi:dev::p::pulumi:pulumi:Stack::p-dev': {
      goal: { type: 'pulumi:pulumi:Stack', outputDiff: { adds: { b: 'two' }, updates: { a: 1 } } },
    },
    'urn:pulumi:dev::p::pulumi:providers:aws::member': {
      goal: {
        type: 'pulumi:providers:aws',
        inputDiff: { updates: { assumeRoles: '[preview]', region: 'eu-west-1' } },
      },
    },
    'urn:pulumi:dev::p::pulumi:providers:aws::new': {
      goal: { type: 'pulumi:providers:aws', inputDiff: { adds: { assumeRoles: '[preview]' } } },
    },
    'urn:pulumi:dev::p::aws:s3/bucket:Bucket::b': {
      goal: { type: 'aws:s3/bucket:Bucket', inputDiff: { updates: { assumeRoles: 'x' } } },
    },
  },
});

test('reads the stack outputs a plan changes', () => {
  assert.deepEqual(stackOutputChanges(plan), ['a', 'b']);
});

test('leaves open only the properties ignore rules name, on the types they name', () => {
  const { text, relaxed } = relaxPlan(plan, [
    { type: 'pulumi:providers:*', properties: ['assumeRoles'] },
    // Rules without properties never relax a plan
    { type: 'aws:s3/bucket:Bucket' },
  ]);
  const goals = JSON.parse(text).resourcePlans;
  const member = goals['urn:pulumi:dev::p::pulumi:providers:aws::member'].goal.inputDiff;
  assert.deepEqual(member.updates, { assumeRoles: UNKNOWN, region: 'eu-west-1' });
  assert.equal(
    goals['urn:pulumi:dev::p::pulumi:providers:aws::new'].goal.inputDiff.adds.assumeRoles,
    UNKNOWN,
  );
  assert.equal(
    goals['urn:pulumi:dev::p::aws:s3/bucket:Bucket::b'].goal.inputDiff.updates.assumeRoles,
    'x',
  );
  assert.equal(relaxed.length, 2);
  assert.deepEqual(relaxPlan(plan, []), { text: plan, relaxed: [] });
});
