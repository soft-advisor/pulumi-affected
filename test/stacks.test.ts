import assert from 'node:assert/strict';
import test from 'node:test';
import { readDependencyGraph } from '../src/select.ts';
import { dependentsOf } from '../src/graph.ts';
import {
  commit,
  createRepo,
  project,
  reasonsOf,
  selectChange,
  selectedIds,
  write,
} from './helpers.ts';
import { select } from '../src/select.ts';

const ACCOUNTS = project('accounts', 'org-accounts', ['business', 'hyperchick', 'management'], {
  'index.ts': "export const accountId = '123';\n",
});

test('a stack config change selects only that stack', () => {
  const result = selectChange(ACCOUNTS, {
    'accounts/Pulumi.business.yaml': 'config:\n  org-accounts:region: us-east-1\n',
  });
  assert.deepEqual(selectedIds(result), ['org-accounts/business']);
  assert.deepEqual(reasonsOf(result, 'org-accounts/business'), [
    'accounts/Pulumi.business.yaml changed',
  ]);
});

test('reformatting a stack config file is not a change', () => {
  const result = selectChange(ACCOUNTS, {
    'accounts/Pulumi.business.yaml':
      '# business account\nconfig:\n    "org-accounts:region": "eu-west-2"\n',
  });
  assert.deepEqual(selectedIds(result), []);
});

test('a new stack is selected', () => {
  const result = selectChange(ACCOUNTS, {
    'accounts/Pulumi.newco.yaml': 'config:\n  org-accounts:region: eu-west-2\n',
  });
  assert.deepEqual(selectedIds(result), ['org-accounts/newco']);
  assert.deepEqual(reasonsOf(result, 'org-accounts/newco'), ['accounts/Pulumi.newco.yaml added']);
});

test('a stack whose base is null was never deployed', () => {
  const { dir, base } = createRepo(ACCOUNTS);
  const result = select({ cwd: dir, base, bases: { 'org-accounts/hyperchick': null } });
  assert.deepEqual(selectedIds(result), ['org-accounts/hyperchick']);
});

test('per-stack bases compare each stack with its own last deploy', () => {
  const { dir, base } = createRepo(ACCOUNTS);
  const second = commit(dir, {
    'accounts/Pulumi.business.yaml': 'config:\n  org-accounts:region: x\n',
  });
  // business was deployed from `second`; management is still at `base`
  commit(dir, { 'accounts/Pulumi.management.yaml': 'config:\n  org-accounts:region: y\n' });
  const result = select({
    cwd: dir,
    base: second,
    bases: { 'org-accounts/business': second, 'org-accounts/management': base },
  });
  assert.deepEqual(selectedIds(result), ['org-accounts/management']);
  const failedBefore = select({
    cwd: dir,
    base: second,
    bases: { 'org-accounts/business': base, 'org-accounts/management': base },
  });
  assert.deepEqual(selectedIds(failedBefore), ['org-accounts/business', 'org-accounts/management']);
});

test('touching a force file selects its stack, even with only whitespace', () => {
  const before = { ...ACCOUNTS, 'accounts/Pulumi.business.force': '' };
  const result = selectChange(before, { 'accounts/Pulumi.business.force': '\n' });
  assert.deepEqual(selectedIds(result), ['org-accounts/business']);
  const created = selectChange(ACCOUNTS, { 'accounts/Pulumi.force': '' });
  assert.deepEqual(selectedIds(created), [
    'org-accounts/business',
    'org-accounts/hyperchick',
    'org-accounts/management',
  ]);
});

test('commit trailers and messages request or skip stacks', () => {
  const requested = selectChange(
    ACCOUNTS,
    {},
    {
      message: 'Check drift\n\nPulumi-Affected-Run: accounts/hyperchick, org-accounts/manage*',
    },
  );
  assert.deepEqual(selectedIds(requested), ['org-accounts/hyperchick', 'org-accounts/management']);
  assert.match(
    reasonsOf(requested, 'org-accounts/hyperchick')[0],
    /^requested by commit [0-9a-f]+$/,
  );

  const all = selectChange(ACCOUNTS, {}, { messages: ['Body\n\nPulumi-Affected-Run: all\n'] });
  assert.equal(all.stacks.length, 3);

  const skipped = selectChange(
    ACCOUNTS,
    { 'accounts/index.ts': "export const accountId = '456';\n" },
    { message: 'x\n\nPulumi-Affected-Skip: business\n' },
  );
  assert.deepEqual(selectedIds(skipped), ['org-accounts/hyperchick', 'org-accounts/management']);
});

test('requesting a pattern that matches nothing warns', () => {
  const result = selectChange(ACCOUNTS, {}, { run: ['nope/*'] });
  assert.deepEqual(result.warnings, ['--run: "nope/*" matches no stack']);
});

test('config rules, always and inputs', () => {
  const before = {
    ...ACCOUNTS,
    'scripts/pulumi.sh': 'echo 1\n',
    'policies/admin.json': '{}',
    'pulumi-affected.yaml': [
      'rules:',
      '  - when: [scripts/**]',
      '    run: [all]',
      'always: [management]',
      'inputs:',
      '  accounts/business: [policies/**]',
      '',
    ].join('\n'),
  };
  assert.deepEqual(selectedIds(selectChange(before, {})), ['org-accounts/management']);
  assert.equal(selectChange(before, { 'scripts/pulumi.sh': 'echo 2\n' }).stacks.length, 3);
  assert.deepEqual(selectedIds(selectChange(before, { 'policies/admin.json': '{ }' })), [
    'org-accounts/business',
    'org-accounts/management',
  ]);
});

test('files read by the program are inputs', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': [
      "import { readFileSync } from 'node:fs';",
      "import * as path from 'node:path';",
      "import * as pulumi from '@pulumi/pulumi';",
      "const POLICY = 'policy.json';",
      'export const policy = readFileSync(path.join(__dirname, POLICY), "utf8");',
      "export const code = new pulumi.asset.FileArchive('./lambda');",
      '',
    ].join('\n'),
    'policy.json': '{}',
    'lambda/handler.js': 'exports.handler = () => 1;\n',
    'other.json': '{}',
  });
  assert.deepEqual(selectedIds(selectChange(before, { 'policy.json': '{"a":1}' })), ['app/dev']);
  const lambda = selectChange(before, { 'lambda/handler.js': 'exports.handler = () => 2;\n' });
  assert.deepEqual(reasonsOf(lambda, 'app/dev'), ['file lambda/handler.js changed']);
  assert.deepEqual(selectedIds(selectChange(before, { 'other.json': '[]' })), []);
});

const DEPENDENT_PROJECTS = {
  ...ACCOUNTS,
  ...project('dns', 'org-dns', ['prod'], {
    'index.ts': [
      "import * as pulumi from '@pulumi/pulumi';",
      "const BUSINESS = 'adpopescu338/org-accounts/business';",
      'export const id = new pulumi.StackReference(BUSINESS).getOutput("accountId");',
      '',
    ].join('\n'),
  }),
  ...project('access', 'org-access', ['prod'], {
    'index.ts': [
      "import * as pulumi from '@pulumi/pulumi';",
      'const config = new pulumi.Config();',
      "const project = config.require('accountsProject');",
      "for (const account of config.requireObject<string[]>('accounts')) {",
      '  new pulumi.StackReference(`${pulumi.getOrganization()}/${project}/${account}`);',
      '}',
      '',
    ].join('\n'),
    'Pulumi.prod.yaml':
      'config:\n  org-access:accountsProject: org-accounts\n  org-access:accounts: [business]\n',
  }),
};

test('stack references become dependencies and order the waves', () => {
  const { dir } = createRepo(DEPENDENT_PROJECTS);
  const { graph, warnings } = readDependencyGraph({ cwd: dir });
  assert.deepEqual([...(graph.get('org-dns/prod') ?? [])], ['org-accounts/business']);
  assert.deepEqual([...(graph.get('org-access/prod') ?? [])].sort(), [
    'org-accounts/business',
    'org-accounts/hyperchick',
    'org-accounts/management',
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(dependentsOf(graph, 'org-accounts/business'), [
    'org-access/prod',
    'org-dns/prod',
  ]);

  const result = selectChange(DEPENDENT_PROJECTS, {}, { all: true });
  assert.deepEqual(result.waves, [
    ['org-accounts/business', 'org-accounts/hyperchick', 'org-accounts/management'],
    ['org-access/prod', 'org-dns/prod'],
  ]);
});

test('dependents are not selected just because what they depend on is', () => {
  const result = selectChange(DEPENDENT_PROJECTS, {
    'accounts/Pulumi.business.yaml': 'config:\n  org-accounts:region: us-east-1\n',
  });
  assert.deepEqual(selectedIds(result), ['org-accounts/business']);
});

test('dependsOn in the config adds dependencies analysis cannot see', () => {
  const before = {
    ...project('', 'site', ['dev', 'prod'], { 'index.ts': 'export const a = 1;\n' }),
    'pulumi-affected.yaml': 'dependsOn:\n  site/prod: [site/dev]\n',
  };
  const result = selectChange(before, { 'index.ts': 'export const a = 2;\n' });
  assert.deepEqual(result.waves, [['site/dev'], ['site/prod']]);
});

test('a stack reference whose name cannot be worked out is reported', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts':
      "import * as pulumi from '@pulumi/pulumi';\nnew pulumi.StackReference(process.env.TARGET!);\n",
  });
  const { dir } = createRepo(before);
  const { warnings } = readDependencyGraph({ cwd: dir });
  assert.match(
    warnings[0],
    /app\/dev: a StackReference in index\.ts has a name that can't be worked out/,
  );
});

test('uncommitted changes in the working tree are analysed when no head is given', () => {
  const { dir, base } = createRepo(ACCOUNTS);
  write(dir, { 'accounts/Pulumi.hyperchick.yaml': 'config:\n  org-accounts:region: x\n' });
  assert.deepEqual(selectedIds(select({ cwd: dir, base })), ['org-accounts/hyperchick']);
});

test('an encryption salt Pulumi adds is not a change, but a changed salt is', () => {
  const added = selectChange(ACCOUNTS, {
    'accounts/Pulumi.business.yaml':
      'encryptionsalt: v1:abc\nconfig:\n  org-accounts:region: eu-west-2\n',
  });
  assert.deepEqual(selectedIds(added), []);
  const salted = {
    ...ACCOUNTS,
    'accounts/Pulumi.business.yaml':
      'encryptionsalt: v1:abc\nconfig:\n  org-accounts:region: eu-west-2\n',
  };
  const changed = selectChange(salted, {
    'accounts/Pulumi.business.yaml':
      'encryptionsalt: v1:def\nconfig:\n  org-accounts:region: eu-west-2\n',
  });
  assert.deepEqual(selectedIds(changed), ['org-accounts/business']);
});

test('Pulumi-Affected-Create-Stacks lines: newer commits and then the pull request win', () => {
  const { dir, base } = createRepo(ACCOUNTS);
  commit(dir, {}, 'First\n\nPulumi-Affected-Create-Stacks: plan');
  commit(
    dir,
    {},
    'Second\n\nPulumi-Affected-Create-Stacks: apply org-accounts/*\nPulumi-Affected-Create-Stacks: apply-later',
  );
  const result = select({ cwd: dir, base });
  assert.deepEqual(
    result.createStacks.map((request) => [request.mode, request.patterns]),
    [
      ['plan', []],
      ['apply', ['org-accounts/*']],
    ],
  );
  assert.ok(result.warnings.some((warning) => warning.includes('apply-later')));
  const withPullRequest = select({
    cwd: dir,
    base,
    messages: ['Pulumi-Affected-Create-Stacks: plan'],
  });
  assert.equal(withPullRequest.createStacks.at(-1)?.source, 'the pull request');
});
