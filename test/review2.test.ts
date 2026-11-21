import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readDependencyGraph, select } from '../src/select.ts';
import { commit, createRepo, type Files, project, selectChange, selectedIds } from './helpers.ts';

/*
 * The second review round: changes that selected nothing, and changes that selected stacks they
 * didn't affect.
 */

const app = (files: Files) => project('app', 'app', ['dev'], files);

function selects(before: Files, change: Files, expected = ['app/dev']) {
  const result = selectChange(before, change);
  assert.deepEqual(
    selectedIds(result),
    expected,
    JSON.stringify(result.stacks.map((s) => s.reasons)),
  );
  return result;
}

test('which binding an import or export refers to counts', () => {
  const lib = "export const prod = 'p';\nexport const dev = 'd';\n";
  selects(
    app({
      'index.ts': "import { prod as config, dev } from './lib';\nexport const a = [config, dev];\n",
      'lib.ts': lib,
    }),
    {
      'app/index.ts':
        "import { dev as config, prod as dev } from './lib';\nexport const a = [config, dev];\n",
    },
  );
  selects(
    app({ 'index.ts': 'const a = 1;\nconst b = 2;\nexport { a as first, b as second };\n' }),
    { 'app/index.ts': 'const a = 1;\nconst b = 2;\nexport { b as first, a as second };\n' },
  );
  selects(
    app({
      'index.ts': "import value from './lib';\nexport const v = value;\n",
      'lib.ts': 'const x = 1;\nconst y = 2;\nexport default x;\nexport { y };\n',
    }),
    { 'app/lib.ts': 'const x = 1;\nconst y = 2;\nexport default y;\nexport { y };\n' },
  );
  selects(app({ 'index.ts': 'const a = 1;\nexport const b = a;\n' }), {
    'app/index.ts': 'export const a = 1;\nexport const b = a;\n',
  });
});

test('__dirname belongs to the module that wrote it', () => {
  selects(
    {
      'lib/paths.ts':
        "import * as path from 'node:path';\nexport const ASSETS = path.join(__dirname, 'assets');\n",
      'lib/assets/x.json': '{}',
      ...app({
        'index.ts':
          "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { ASSETS } from '../lib/paths';\nexport const x = readFileSync(join(ASSETS, 'x.json'), 'utf8');\n",
      }),
    },
    { 'lib/assets/x.json': '{"a":1}' },
  );
});

test('reading the whole repository or above the project counts every change, and never crashes', () => {
  selects(
    {
      'other/x.ts': '1',
      ...app({
        'index.ts':
          "import { readdirSync } from 'node:fs';\nexport const all = readdirSync('..');\n",
      }),
    },
    { 'other/x.ts': '2' },
  );
  selects(
    {
      'web/src/a.ts': '1',
      ...app({
        'index.ts':
          "import * as docker from '@pulumi/docker';\nnew docker.Image('web', { build: { context: '../' }, imageName: 'web' });\n",
      }),
    },
    { 'web/src/a.ts': '2' },
  );
});

test("a shorthand context, and one that can't be worked out, count", () => {
  selects(
    {
      'web/Dockerfile': 'FROM a\n',
      ...app({
        'index.ts':
          "import * as path from 'node:path';\nconst context = path.join(__dirname, '..', 'web');\nexport const build = { context };\n",
      }),
    },
    { 'web/Dockerfile': 'FROM b\n' },
  );
  const result = selects(
    app({
      'index.ts':
        "export function image(dir: string) { return { build: { context: dir } }; }\nexport const i = image(process.env.DIR ?? 'x');\n",
      Dockerfile: 'FROM a\n',
    }),
    { 'app/Dockerfile': 'FROM b\n' },
  );
  assert.ok(result.warnings.some((warning) => warning.includes('Docker build context')));
});

test('fs bound with require is a file-system module', () => {
  selects(
    app({
      'index.ts': "import fs = require('fs');\nfs.copyFileSync('./a.txt', '/tmp/b');\n",
      'a.txt': 'a',
    }),
    { 'app/a.txt': 'b' },
  );
});

test('a package.json outside the workspaces does not stand in for an npm package', () => {
  const lock = (version: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { 'left-pad': '*' } }, 'node_modules/left-pad': { version } },
    });
  selects(
    {
      'package-lock.json': lock('1.0.0'),
      'vendor/left-pad/package.json': JSON.stringify({ name: 'left-pad' }),
      'vendor/left-pad/index.js': 'module.exports = 1;\n',
      ...app({ 'index.ts': "import pad from 'left-pad';\nexport const p = pad;\n" }),
    },
    { 'package-lock.json': lock('1.3.0') },
  );
});

test('packageManager chooses between lockfiles', () => {
  const lock = (version: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { tool: '*' } }, 'node_modules/tool': { version } },
    });
  selects(
    {
      'package.json': JSON.stringify({ packageManager: 'npm@10.0.0', dependencies: { tool: '*' } }),
      'yarn.lock': '# yarn lockfile v1\n\ntool@*:\n  version "1.0.0"\n',
      'package-lock.json': lock('1.0.0'),
      ...app({ 'index.ts': "import 'tool';\n" }),
    },
    { 'package-lock.json': lock('1.1.0') },
  );
});

test('a project that kept its template section still has stacks', () => {
  selects(
    app({
      'Pulumi.yaml': 'name: app\nruntime: nodejs\ntemplate:\n  description: x\n',
      'index.ts': 'export const a = 1;\n',
    }),
    {
      'app/index.ts': 'export const a = 2;\n',
    },
  );
});

test('process.loadEnvFile() reads .env', () => {
  selects(app({ 'index.ts': 'process.loadEnvFile();\n', '.env': 'A=1\n' }), {
    'app/.env': 'A=2\n',
  });
});

test("a main file runs in its own folder, with that folder's tsconfig", () => {
  const before = app({
    'Pulumi.yaml': 'name: app\nruntime: nodejs\nmain: src/index.ts\n',
    'src/index.ts':
      "import { readFileSync } from 'node:fs';\nexport const d = readFileSync('data.json', 'utf8');\n",
    'src/data.json': '{}',
    'src/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  });
  selects(before, { 'app/src/data.json': '{"a":1}' });
  selects(before, {
    'app/src/tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }),
  });
});

test("a main folder's own lockfile counts", () => {
  const lock = (version: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { 'left-pad': '*' } }, 'node_modules/left-pad': { version } },
    });
  selects(
    app({
      'Pulumi.yaml': 'name: app\nruntime: nodejs\nmain: program/\n',
      'program/index.ts': "import pad from 'left-pad';\nexport const p = pad;\n",
      'program/package.json': JSON.stringify({ dependencies: { 'left-pad': '*' } }),
      'program/package-lock.json': lock('1.0.0'),
    }),
    { 'app/program/package-lock.json': lock('1.3.0') },
  );
});

test('the entry follows package.json exports, and a main that does not exist falls back', () => {
  selects(
    app({
      'package.json': JSON.stringify({ exports: { '.': './b.ts' }, main: 'a.ts' }),
      'a.ts': 'export const w = "a";\n',
      'b.ts': 'export const w = "b";\n',
    }),
    { 'app/b.ts': 'export const w = "B";\n' },
  );
  selects(
    {
      'package.json': JSON.stringify({ name: 'root', main: 'index.js' }),
      'index.ts': '1;\n',
      ...app({ 'index.ts': 'export const a = 1;\n' }),
    },
    { 'app/index.ts': 'export const a = 2;\n' },
  );
});

test('a main naming build output that is not committed maps to its source', () => {
  selects(
    app({
      'Pulumi.yaml':
        'name: app\nruntime:\n  name: nodejs\n  options:\n    typescript: false\nmain: bin/index.js\n',
      'bin/tsconfig.json': JSON.stringify({ compilerOptions: { rootDir: '../src', outDir: '.' } }),
      'src/index.ts': 'export const a = 1;\n',
    }),
    { 'app/src/index.ts': 'export const a = 2;\n' },
  );
});

test('Pulumi.json projects and Bun projects are analysed', () => {
  selects(
    {
      'app/Pulumi.json': JSON.stringify({ name: 'app', runtime: 'nodejs' }),
      'app/Pulumi.dev.json': '{}',
      'app/index.ts': 'export const a = 1;\n',
    },
    { 'app/index.ts': 'export const a = 2;\n' },
  );
  const bun = selectChange(
    {
      ...app({ 'Pulumi.yaml': 'name: app\nruntime: bun\n', 'index.ts': 'export const a = 1;\n' }),
      'app/notes.txt': 'x',
    },
    { 'app/notes.txt': 'y' },
  );
  assert.deepEqual(selectedIds(bun), [], 'Bun programs are analysed, not watched folder by folder');
});

test('a two-part stack reference is org/stack in the same project', () => {
  const { dir } = createRepo({
    ...project('net', 'net', ['dev']),
    'net/index.ts':
      "import * as pulumi from '@pulumi/pulumi';\nnew pulumi.StackReference(`${pulumi.getOrganization()}/prod`);\n",
    ...project('app', 'app', ['dev', 'prod'], { 'index.ts': '1;\n' }),
  });
  assert.deepEqual(readDependencyGraph({ cwd: dir }).graph.get('net/dev'), undefined);
});

test('these select nothing', () => {
  const unchanged: [string, Files, Files][] = [
    [
      'a constant used elsewhere in a shared module',
      {
        'lib/c.ts':
          "import * as aws from '@pulumi/aws';\nexport const x = aws.ec2.InstanceType.T3_Micro;\nexport const y = aws.ec2.InstanceType.T3_Small;\n",
        ...app({ 'index.ts': "import { x } from '../lib/c';\nexport const a = x;\n" }),
      },
      {
        'lib/c.ts':
          "import * as aws from '@pulumi/aws';\nexport const x = aws.ec2.InstanceType.T3_Micro;\nexport const y = aws.ec2.InstanceType.T3_Large;\n",
      },
    ],
    [
      'an unused enum',
      app({
        'index.ts': "import { a } from './lib';\nexport const v = a;\n",
        'lib.ts': 'export const a = 1;\nexport enum Size { S = 1 }\n',
      }),
      { 'app/lib.ts': 'export const a = 1;\nexport enum Size { S = 2 }\n' },
    ],
    [
      'sorted package imports',
      app({
        'index.ts':
          "import * as random from '@pulumi/random';\nimport * as aws from '@pulumi/aws';\nexport const a = [aws, random];\n",
      }),
      {
        'app/index.ts':
          "import * as aws from '@pulumi/aws';\nimport * as random from '@pulumi/random';\nexport const a = [aws, random];\n",
      },
    ],
    [
      'a moved function declaration',
      app({ 'index.ts': 'export const a = f();\nfunction f() { return 1; }\n' }),
      { 'app/index.ts': 'function f() { return 1; }\nexport const a = f();\n' },
    ],
    [
      "a bare './', the program's own file, and a sibling through '../'",
      {
        ...project('infra/app', 'app', ['dev'], {
          'index.ts': "export const o = { cwd: './', file: 'index.ts', up: '../' };\n",
        }),
        'infra/other/x.ts': '1',
      },
      { 'infra/other/x.ts': '2' },
    ],
    [
      'a method merely named like a reader',
      app({
        'index.ts': "declare const zip: any;\nexport const r = zip.readFile('README');\n",
        'x.txt': '1',
      }),
      { 'app/x.txt': '2' },
    ],
    [
      "require('./data') of data.json is followed, not a gap",
      app({ 'index.ts': "export const d = require('./data');\n", 'data.json': '{}', 'x.txt': '1' }),
      { 'app/x.txt': '2' },
    ],
    [
      'a registry package whose checksum format changed',
      {
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { tool: '*' } },
            'node_modules/tool': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz',
              integrity: 'sha1-a',
            },
          },
        }),
        ...app({ 'index.ts': "import 'tool';\n" }),
      },
      {
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { tool: '*' } },
            'node_modules/tool': {
              version: '1.0.0',
              resolved: 'https://mirror.example.com/tool/-/tool-1.0.0.tgz',
              integrity: 'sha512-b',
            },
          },
        }),
      },
    ],
  ];
  for (const [name, before, change] of unchanged) {
    const result = selectChange(before, change);
    assert.deepEqual(
      selectedIds(result),
      [],
      `${name}: ${JSON.stringify(result.stacks.map((s) => s.reasons))}`,
    );
  }
});

test('a symlinked folder is not a change on every diff', () => {
  const { dir } = createRepo({
    'shared/a.ts': '1',
    ...app({ 'index.ts': "export const r = require('./lib/a');\n" }),
  });
  symlinkSync('../shared', join(dir, 'app/lib'));
  const linked = commit(dir, {});
  const head = commit(dir, { 'README.md': 'x' });
  assert.deepEqual(selectedIds(select({ cwd: dir, base: linked, head })), []);
});
