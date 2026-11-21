import assert from 'node:assert/strict';
import test from 'node:test';
import { type Files, project, reasonsOf, selectChange, selectedIds } from './helpers.ts';

/*
 * `alpha` imports @pulumi/aws (which depends on @pulumi/pulumi, which depends on semver);
 * `beta` imports left-pad. Every program runs @pulumi/pulumi. prettier is installed but no
 * program loads it.
 */
interface Versions {
  aws: string;
  pulumi: string;
  semver: string;
  leftPad: string;
  prettier: string;
}

const V1: Versions = {
  aws: '6.0.0',
  pulumi: '3.100.0',
  semver: '7.0.0',
  leftPad: '1.0.0',
  prettier: '3.0.0',
};

const PROJECTS: Files = {
  ...project('alpha', 'alpha', ['dev'], {
    'index.ts': "import * as aws from '@pulumi/aws';\nnew aws.s3.Bucket('b');\n",
  }),
  ...project('beta', 'beta', ['dev'], {
    'index.ts': "import leftPad from 'left-pad';\nexport const x = leftPad('a', 2);\n",
  }),
};

const MANIFEST = JSON.stringify({
  name: 'root',
  private: true,
  dependencies: { '@pulumi/aws': '^6', '@pulumi/pulumi': '^3', 'left-pad': '^1' },
  devDependencies: { prettier: '^3' },
});

const lockfiles: Record<string, (v: Versions) => Files> = {
  npm: (v) => ({
    'package-lock.json': JSON.stringify({
      name: 'root',
      lockfileVersion: 3,
      packages: {
        '': JSON.parse(MANIFEST),
        'node_modules/@pulumi/aws': { version: v.aws, dependencies: { '@pulumi/pulumi': '^3' } },
        'node_modules/@pulumi/pulumi': { version: v.pulumi, dependencies: { semver: '^7' } },
        'node_modules/semver': { version: v.semver },
        'node_modules/left-pad': { version: v.leftPad },
        'node_modules/prettier': { version: v.prettier, dev: true },
      },
    }),
  }),
  pnpm: (v) => ({
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      '@pulumi/aws': {specifier: ^6, version: ${v.aws}}`,
      `      '@pulumi/pulumi': {specifier: ^3, version: ${v.pulumi}}`,
      `      left-pad: {specifier: ^1, version: ${v.leftPad}}`,
      '    devDependencies:',
      `      prettier: {specifier: ^3, version: ${v.prettier}}`,
      'snapshots:',
      `  '@pulumi/aws@${v.aws}':`,
      '    dependencies:',
      `      '@pulumi/pulumi': ${v.pulumi}`,
      `  '@pulumi/pulumi@${v.pulumi}':`,
      '    dependencies:',
      `      semver: ${v.semver}`,
      `  semver@${v.semver}: {}`,
      `  left-pad@${v.leftPad}: {}`,
      `  prettier@${v.prettier}: {}`,
      '',
    ].join('\n'),
  }),
  'yarn classic': (v) => ({
    'yarn.lock': [
      '# yarn lockfile v1',
      '',
      '"@pulumi/aws@^6":',
      `  version "${v.aws}"`,
      '  dependencies:',
      '    "@pulumi/pulumi" "^3"',
      '',
      '"@pulumi/pulumi@^3":',
      `  version "${v.pulumi}"`,
      '  dependencies:',
      '    semver "^7"',
      '',
      'semver@^7:',
      `  version "${v.semver}"`,
      '',
      'left-pad@^1:',
      `  version "${v.leftPad}"`,
      '',
      'prettier@^3:',
      `  version "${v.prettier}"`,
      '',
    ].join('\n'),
  }),
  'yarn berry': (v) => ({
    'yarn.lock': [
      '__metadata:',
      '  version: 8',
      '',
      '"@pulumi/aws@npm:^6":',
      `  version: ${v.aws}`,
      `  resolution: "@pulumi/aws@npm:${v.aws}"`,
      '  dependencies:',
      '    "@pulumi/pulumi": "npm:^3"',
      '',
      '"@pulumi/pulumi@npm:^3":',
      `  version: ${v.pulumi}`,
      `  resolution: "@pulumi/pulumi@npm:${v.pulumi}"`,
      '  dependencies:',
      '    semver: "npm:^7"',
      '',
      '"semver@npm:^7":',
      `  version: ${v.semver}`,
      `  resolution: "semver@npm:${v.semver}"`,
      '',
      '"left-pad@npm:^1":',
      `  version: ${v.leftPad}`,
      `  resolution: "left-pad@npm:${v.leftPad}"`,
      '',
      '"prettier@npm:^3":',
      `  version: ${v.prettier}`,
      `  resolution: "prettier@npm:${v.prettier}"`,
      '',
      '"root@workspace:.":',
      '  version: 0.0.0-use.local',
      '  resolution: "root@workspace:."',
      '  dependencies:',
      '    "@pulumi/aws": "npm:^6"',
      '    "@pulumi/pulumi": "npm:^3"',
      '    left-pad: "npm:^1"',
      '    prettier: "npm:^3"',
      '',
    ].join('\n'),
  }),
};

for (const [manager, lockfile] of Object.entries(lockfiles)) {
  const before = { ...PROJECTS, 'package.json': MANIFEST, ...lockfile(V1) };

  test(`${manager}: a package bump selects only projects that load it`, () => {
    const result = selectChange(before, lockfile({ ...V1, leftPad: '1.1.0' }));
    assert.deepEqual(selectedIds(result), ['beta/dev']);
    assert.deepEqual(reasonsOf(result, 'beta/dev'), ['package left-pad 1.0.0 → 1.1.0']);
  });

  test(`${manager}: a transitive bump selects projects that load it indirectly`, () => {
    const result = selectChange(before, lockfile({ ...V1, aws: '6.1.0' }));
    assert.deepEqual(selectedIds(result), ['alpha/dev']);
  });

  test(`${manager}: the Pulumi SDK's dependencies affect every program`, () => {
    const result = selectChange(before, lockfile({ ...V1, semver: '7.1.0' }));
    assert.deepEqual(selectedIds(result), ['alpha/dev', 'beta/dev']);
  });

  test(`${manager}: a package no program loads selects nothing`, () => {
    const result = selectChange(before, lockfile({ ...V1, prettier: '3.1.0' }));
    assert.deepEqual(selectedIds(result), []);
  });
}

test('packages.ignore leaves out matching packages', () => {
  const before = {
    ...PROJECTS,
    'package.json': MANIFEST,
    ...lockfiles.npm(V1),
    'pulumi-affected.yaml': 'packages:\n  ignore: [left-pad]\n',
  };
  const result = selectChange(before, lockfiles.npm({ ...V1, leftPad: '1.1.0' }));
  assert.deepEqual(selectedIds(result), []);
});

test('type declaration packages never count, even when a runtime dependency lists one', () => {
  const lock = (types: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { tool: '*' } },
        'node_modules/tool': { version: '1.0.0', dependencies: { '@types/node': '*' } },
        'node_modules/@types/node': { version: types },
      },
    });
  const before = {
    ...project('', 'app', ['dev'], { 'index.ts': "import 'tool';\n" }),
    'package-lock.json': lock('22.0.0'),
  };
  assert.deepEqual(selectedIds(selectChange(before, { 'package-lock.json': lock('22.1.0') })), []);
});
