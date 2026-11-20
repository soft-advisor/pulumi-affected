import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, formatCounts, parseFirstJson } from '../src/classify.ts';

const STACK_URN = 'urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev';
const urn = (type: string, name: string) => `urn:pulumi:dev::app::${type}::${name}`;
const state = (type: string, outputs?: Record<string, unknown> | null) => ({ type, outputs });

function preview(steps: unknown[]) {
  return JSON.stringify({ steps, changeSummary: {} }, null, 4);
}

test('a preview with only unchanged resources has no changes', () => {
  const result = classify(
    preview([
      {
        op: 'same',
        urn: STACK_URN,
        oldState: state('pulumi:pulumi:Stack', {}),
        newState: state('pulumi:pulumi:Stack', null),
      },
      { op: 'same', urn: urn('aws:s3/bucket:Bucket', 'b') },
      { op: 'read', urn: urn('aws:iam/getPolicy:getPolicy', 'p') },
    ]),
  );
  assert.equal(result.changed, false);
  assert.equal(formatCounts(result), 'no changes');
});

test('creates, updates and deletes are counted, and a replacement counts once', () => {
  const bucket = urn('aws:s3/bucket:Bucket', 'b');
  const result = classify(
    preview([
      {
        op: 'create',
        urn: urn('aws:sns/topic:Topic', 't'),
        newState: state('aws:sns/topic:Topic'),
      },
      {
        op: 'update',
        urn: urn('aws:iam/role:Role', 'r'),
        newState: state('aws:iam/role:Role'),
        diffReasons: ['tags'],
        detailedDiff: { 'tags.team': {}, assumeRolePolicy: {} },
      },
      { op: 'create-replacement', urn: bucket, newState: state('aws:s3/bucket:Bucket') },
      { op: 'replace', urn: bucket, newState: state('aws:s3/bucket:Bucket') },
      { op: 'delete-replaced', urn: bucket, oldState: state('aws:s3/bucket:Bucket') },
      {
        op: 'delete',
        urn: urn('aws:sqs/queue:Queue', 'q'),
        oldState: state('aws:sqs/queue:Queue'),
      },
    ]),
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.counts, { create: 1, update: 1, replace: 1, delete: 1 });
  assert.equal(formatCounts(result), '+1 ~1 ±1 -1');
  const role = result.changes.find((change) => change.name === 'r');
  assert.deepEqual(role?.properties, ['assumeRolePolicy', 'tags']);
  assert.equal(role?.type, 'aws:iam/role:Role');
});

test('ignore rules drop known noise, but only updates of the listed properties', () => {
  const provider = urn('pulumi:providers:aws', 'member');
  const steps = (properties: string[]) => [
    {
      op: 'update',
      urn: provider,
      newState: state('pulumi:providers:aws'),
      diffReasons: properties,
    },
  ];
  const rules = [{ type: 'pulumi:providers:*', properties: ['assumeRole', 'assumeRoles'] }];
  const noise = classify(preview(steps(['assumeRole'])), rules);
  assert.equal(noise.changed, false);
  assert.equal(noise.ignored.length, 1);
  const real = classify(preview(steps(['assumeRole', 'region'])), rules);
  assert.equal(real.changed, true);
  const unknownProperties = classify(preview(steps([])), rules);
  assert.equal(unknownProperties.changed, true, 'without diff details, a change is kept');
});

test('changed stack outputs count when the preview knows them', () => {
  const result = classify(
    preview([
      {
        op: 'same',
        urn: STACK_URN,
        oldState: state('pulumi:pulumi:Stack', { url: 'a', id: 1 }),
        newState: state('pulumi:pulumi:Stack', { url: 'b', id: 1 }),
      },
    ]),
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.outputs, ['url']);
});

test('`up --json` output is read from its first document, ignoring the events after it', () => {
  const output = `${preview([{ op: 'create', urn: urn('random:index/randomPet:RandomPet', 'p') }])}\n{"sequence":0,"preludeEvent":{}}\n{"sequence":1,"summaryEvent":{}}\n`;
  assert.deepEqual(classify(output).counts, { create: 1 });
  assert.deepEqual(parseFirstJson('noise {"a": "}{"} {"b": 1}'), { a: '}{' });
});

test('output that is not a preview is rejected', () => {
  assert.throws(() => classify('error: no stack named dev found'), /no steps list/);
});
