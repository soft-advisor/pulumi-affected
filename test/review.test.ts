import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { select } from '../src/select.ts';
import {
  commit,
  createRepo,
  type Files,
  project,
  reasonsOf,
  run,
  selectChange,
  selectedIds,
} from './helpers.ts';

/*
 * Changes the review found selecting nothing. Each must select the stack, or be selected through
 * the fallback for code analysis can't follow.
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

test('import = require() and export = are followed', () => {
  selects(
    app({
      'index.ts': "import lib = require('./lib');\nlib.go();\n",
      'lib.ts': 'export function go() { return 1; }\n',
    }),
    { 'app/lib.ts': 'export function go() { return 2; }\n' },
  );
  selects(app({ 'index.ts': "export = { bucket: 'a' };\n" }), {
    'app/index.ts': "export = { bucket: 'b' };\n",
  });
});

test("a gap in shared code outside the project watches that code's folder", () => {
  const result = selects(
    {
      'lib/policies.ts': [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export function policy(name: string) { return readFileSync(join(__dirname, 'policies', name + '.json'), 'utf8'); }",
        '',
      ].join('\n'),
      'lib/policies/admin.json': '{}',
      ...app({
        'index.ts':
          "import { policy } from '../lib/policies';\nexport const p = policy('admin');\n",
      }),
    },
    { 'lib/policies/admin.json': '{"a":1}' },
  );
  assert.match(
    reasonsOf(result, 'app/dev')[0],
    /lib\/policies\/admin\.json changed \(lib\/policies\.ts: a file is read/,
  );
});

test('inputs in the config no longer switch the fallback off', () => {
  selects(
    {
      ...app({
        'index.ts': "const m = process.env.M ?? 'a';\nrequire('./envs/' + m);\n",
        'envs/a.ts': 'export const a = 1;\n',
      }),
      'unrelated/x.txt': 'x',
      'pulumi-affected.yaml': 'inputs:\n  app/dev: [unrelated/**]\n',
    },
    { 'app/envs/a.ts': 'export const a = 2;\n' },
  );
});

test('an archive of build output that is not committed watches the folder it is built in', () => {
  selects(
    {
      'lambda/src/handler.ts': 'export const handler = () => 1;\n',
      ...app({
        'index.ts':
          "import * as pulumi from '@pulumi/pulumi';\nexport const code = new pulumi.asset.FileArchive('../lambda/dist');\n",
      }),
    },
    { 'lambda/src/handler.ts': 'export const handler = () => 2;\n' },
  );
});

test('a Docker build context is an input, and an unrelated string is not', () => {
  const before = {
    'service/Dockerfile': 'FROM node:22\n',
    'other/file.txt': 'x',
    ...app({
      'index.ts': [
        "import * as docker from '@pulumi/docker';",
        "export const image = new docker.Image('svc', { build: { context: '../service' }, imageName: 'other' });",
        '',
      ].join('\n'),
    }),
  };
  selects(before, { 'service/Dockerfile': 'FROM node:24\n' });
  selects(before, { 'other/file.txt': 'y' }, []);
});

test('reads through any imported file-system function count, under any name', () => {
  selects(
    app({
      'index.ts':
        "import { readFileSync as rf } from 'fs';\nexport const a = rf('./data.txt', 'utf8');\n",
      'data.txt': 'a',
    }),
    { 'app/data.txt': 'b' },
  );
  selects(
    {
      'site/a.js': '1',
      ...app({
        'index.ts':
          "import { globSync } from 'glob';\nexport const files = globSync('../site/*.js');\n",
      }),
    },
    { 'site/a.js': '2' },
  );
});

test('require.resolve() paths are relative to the module', () => {
  selects(
    {
      'lib/a.ts':
        "import * as pulumi from '@pulumi/pulumi';\nexport const asset = new pulumi.asset.FileAsset(require.resolve('./data.txt'));\n",
      'lib/data.txt': 'a',
      ...app({ 'index.ts': "export { asset } from '../lib/a';\n" }),
    },
    { 'lib/data.txt': 'b' },
  );
});

test('a parameter that shadows a constant is not that constant', () => {
  selects(
    app({
      'index.ts': [
        "import { readFileSync } from 'node:fs';",
        "const file = 'a.json';",
        'function load(file: string) { return readFileSync(file, "utf8"); }',
        "export const b = load('b.json');",
        '',
      ].join('\n'),
      'a.json': '{}',
      'b.json': '{}',
    }),
    { 'app/b.json': '{"b":1}' },
  );
});

test('tsconfig extends from a workspace package keeps its paths', () => {
  selects(
    {
      'packages/tsconfig/package.json': JSON.stringify({ name: '@org/tsconfig' }),
      'packages/tsconfig/base.json': JSON.stringify({
        compilerOptions: { baseUrl: '../..', paths: { '@lib/*': ['lib/*'] } },
      }),
      'lib/naming.ts': 'export function name() { return 1; }\n',
      'app/tsconfig.json': JSON.stringify({ extends: '@org/tsconfig/base.json' }),
      ...app({ 'index.ts': "import { name } from '@lib/naming';\nexport const n = name();\n" }),
    },
    { 'lib/naming.ts': 'export function name() { return 2; }\n' },
  );
});

test('package.json imports (#alias) resolve', () => {
  selects(
    {
      'package.json': JSON.stringify({ name: 'root', imports: { '#lib/*': './lib/*.js' } }),
      'lib/naming.ts': 'export function name() { return 1; }\n',
      ...app({ 'index.ts': "import { name } from '#lib/naming';\nexport const n = name();\n" }),
    },
    { 'lib/naming.ts': 'export function name() { return 2; }\n' },
  );
});

const npmLock = (resolved: string, version = '1.0.0') =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { tool: '*' } },
      'node_modules/tool': { version, resolved, integrity: `sha512-${resolved}` },
    },
  });

test('a git dependency moving to another commit at the same version counts', () => {
  selects(
    {
      'package-lock.json': npmLock('git+ssh://git@github.com/o/tool.git#aaa'),
      ...app({ 'index.ts': "import 'tool';\n" }),
    },
    { 'package-lock.json': npmLock('git+ssh://git@github.com/o/tool.git#bbb') },
  );
});

test('a patch-package patch counts as a change to the package it patches', () => {
  selects(
    {
      'package-lock.json': npmLock('https://r/tool.tgz'),
      'patches/tool+1.0.0.patch': 'a',
      ...app({ 'index.ts': "import 'tool';\n" }),
    },
    { 'patches/tool+1.0.0.patch': 'b' },
  );
});

test('without a lockfile, dependency ranges in package.json count', () => {
  selects(
    {
      'app/package.json': JSON.stringify({ dependencies: { tool: '^1' } }),
      ...app({ 'index.ts': "import 'tool';\n" }),
    },
    { 'app/package.json': JSON.stringify({ dependencies: { tool: '^2' } }) },
  );
});

test('an unsupported lockfile counts as changed whenever its text changes', () => {
  selects(
    {
      'pnpm-lock.yaml': 'lockfileVersion: 5.4\npackages:\n  /tool/1.0.0: {}\n',
      ...app({ 'index.ts': "import 'tool';\n" }),
    },
    { 'pnpm-lock.yaml': 'lockfileVersion: 5.4\npackages:\n  /tool/1.1.0: {}\n' },
  );
});

test('bun.lock is read package by package', () => {
  const lock = (version: string) =>
    `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "dependencies": { "tool": "^1" } } },\n  "packages": {\n    "tool": ["tool@${version}", "", {}, "sha512-${version}"],\n  },\n}\n`;
  const result = selects(
    { 'bun.lock': lock('1.0.0'), ...app({ 'index.ts': "import 'tool';\n" }) },
    { 'bun.lock': lock('1.1.0') },
  );
  assert.ok(reasonsOf(result, 'app/dev').includes('package tool 1.0.0 → 1.1.0'));
});

test('an import the lockfile does not resolve is a gap', () => {
  const result = selects(
    {
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
      ...app({
        'index.ts': "import { x } from 'mystery';\nexport const a = x;\n",
        'other.ts': '1',
      }),
    },
    { 'app/other.ts': '2' },
  );
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('"mystery", which the lockfile doesn\'t resolve'),
    ),
  );
});

test('config values are compared as written, not as numbers', () => {
  selects(app({ 'index.ts': '1;\n', 'Pulumi.dev.yaml': 'config:\n  app:version: 1.10\n' }), {
    'app/Pulumi.dev.yaml': 'config:\n  app:version: 1.1\n',
  });
  selects(
    app({ 'index.ts': '1;\n', 'Pulumi.dev.yaml': 'config:\n  app:id: 1234567890123456789\n' }),
    {
      'app/Pulumi.dev.yaml': 'config:\n  app:id: 1234567890123456788\n',
    },
  );
});

test('import order and declaration order count', () => {
  const files = (first: string, second: string) =>
    app({
      'index.ts': `import './${first}';\nimport './${second}';\n`,
      'a.ts': 'globalThis.x = 1;\n',
      'b.ts': 'globalThis.x = 2;\n',
    });
  selects(files('a', 'b'), files('b', 'a'));
  selects(app({ 'index.ts': "var name = 'a';\nexport const b = String(name);\n" }), {
    'app/index.ts': "export const b = String(name);\nvar name = 'a';\n",
  });
});

test('a variable declared twice keeps both declarations', () => {
  selects(app({ 'index.ts': "var x = String('a');\nvar x;\nexport { x };\n" }), {
    'app/index.ts': "var x = String('b');\nvar x;\nexport { x };\n",
  });
});

test('getters and computed class keys run code', () => {
  selects(
    app({
      'index.ts': "import { registry } from './registry';\nconst unused = registry.make;\n",
      'registry.ts': "export const registry = { get make() { return String('a'); } };\n",
    }),
    { 'app/registry.ts': "export const registry = { get make() { return String('b'); } };\n" },
  );
  selects(app({ 'index.ts': "class A { [String('a')]() {} }\n" }), {
    'app/index.ts': "class A { [String('b')]() {} }\n",
  });
});

test('eval, new Function and createRequire are gaps', () => {
  const result = selects(
    app({ 'index.ts': "eval('helper()');\nfunction helper() { return 1; }\n" }),
    { 'app/index.ts': "eval('helper()');\nfunction helper() { return 2; }\n" },
  );
  assert.ok(result.warnings.some((warning) => warning.includes('eval()')));
  const lambda = selectChange(
    app({
      'index.ts': "import * as aws from '@pulumi/aws';\nnew aws.lambda.Function('f', {});\n",
      'x.txt': '1',
    }),
    { 'app/x.txt': '2' },
  );
  assert.deepEqual(lambda.warnings, [], 'a Lambda function resource is not new Function()');
});

test('strict mode settings count', () => {
  selects(
    app({
      'index.ts': 'export const a = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
    }),
    { 'app/tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }) },
  );
});

test("dotenv's .env file is an input", () => {
  selects(app({ 'index.ts': "import 'dotenv/config';\n", '.env': 'A=1\n' }), {
    'app/.env': 'A=2\n',
  });
});

test('runtime options: nodeargs preloads and a tsconfig of its own', () => {
  const pulumiYaml = (options: string) =>
    `name: app\nruntime:\n  name: nodejs\n  options:\n${options}`;
  selects(
    app({
      'Pulumi.yaml': pulumiYaml('    nodeargs: --require ./setup.js\n'),
      'index.ts': '1;\n',
      'setup.js': 'globalThis.a = 1;\n',
    }),
    { 'app/setup.js': 'globalThis.a = 2;\n' },
  );
  selects(
    app({
      'Pulumi.yaml': pulumiYaml('    tsconfig: tsconfig.build.json\n'),
      'index.ts': '1;\n',
      'tsconfig.build.json': JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
    }),
    {
      'app/tsconfig.build.json': JSON.stringify({
        compilerOptions: { experimentalDecorators: false },
      }),
    },
  );
});

test('main as a folder runs the nearest package.json main, in that folder', () => {
  const before = app({
    'Pulumi.yaml': 'name: app\nruntime: nodejs\nmain: src/\n',
    'package.json': JSON.stringify({ main: 'index.js' }),
    'index.js':
      "const fs = require('fs');\nmodule.exports = fs.readFileSync(process.cwd() + '/policy.json', 'utf8');\n",
    'src/index.ts': 'export const unused = 1;\n',
    'src/policy.json': '{}',
  });
  selects(before, { 'app/index.js': "module.exports = 'changed';\n" });
  selects(before, { 'app/src/policy.json': '{"a":1}' });
});

test('symbolic links inside the repository are followed', () => {
  const { dir, base } = createRepo({
    'shared/naming.ts': 'export function name() { return 1; }\n',
    ...app({ 'index.ts': "import { name } from './lib/naming';\nexport const n = name();\n" }),
  });
  symlinkSync('../shared', join(dir, 'app/lib'));
  const linked = commit(dir, {});
  const head = commit(dir, { 'shared/naming.ts': 'export function name() { return 2; }\n' });
  assert.deepEqual(selectedIds(select({ cwd: dir, base: linked, head })), ['app/dev']);
  assert.ok(base);
});

test('a submodule moving to another commit selects projects that use it', () => {
  const library = createRepo({ 'index.ts': 'export const a = 1;\n' });
  const { dir } = createRepo(
    app({ 'index.ts': "import { a } from '../vendor/lib';\nexport const x = a;\n" }),
  );
  run(dir, 'git', [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    library.dir,
    'vendor/lib',
  ]);
  const added = commit(dir, {}, 'add submodule');
  commit(library.dir, { 'index.ts': 'export const a = 2;\n' });
  run(join(dir, 'vendor/lib'), 'git', ['pull', '-q', 'origin', 'main']);
  const bumped = commit(dir, {}, 'bump submodule');
  assert.deepEqual(selectedIds(select({ cwd: dir, base: added, head: bumped })), ['app/dev']);
});

test('stack files follow the project file extension, and templates are skipped', () => {
  const result = selectChange(
    {
      ...app({ 'index.ts': '1;\n' }),
      'app/Pulumi.dev.yml': 'config: {}\n',
      'templates/a/Pulumi.yaml': 'name: ${PROJECT}\nruntime: nodejs\ntemplate:\n  description: x\n',
      'templates/b/Pulumi.yaml': 'name: ${PROJECT}\nruntime: nodejs\ntemplate:\n  description: y\n',
    },
    { 'app/Pulumi.dev.yml': 'config: {a: 1}\n' },
  );
  assert.deepEqual(selectedIds(result), []);
  assert.ok(result.warnings.some((warning) => warning.includes('is a project template')));
});

test("rules use each stack's own base", () => {
  const { dir, base } = createRepo({
    ...app({ 'index.ts': '1;\n' }),
    'schema/a.sql': '1',
    'pulumi-affected.yaml': 'rules:\n  - when: [schema/**]\n    run: [app/dev]\n',
  });
  const failed = commit(dir, { 'schema/a.sql': '2' });
  const head = commit(dir, { 'README.md': 'x' });
  const result = select({ cwd: dir, base: failed, head, bases: { 'app/dev': base } });
  assert.deepEqual(selectedIds(result), ['app/dev']);
});
