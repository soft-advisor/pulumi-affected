import assert from 'node:assert/strict';
import test from 'node:test';
import { project, reasonsOf, selectChange, selectedIds } from './helpers.ts';

// Two projects sharing lib/: `alpha` uses bucketName, `beta` uses roleName
const SHARED = {
  'lib/naming.ts': [
    'export function bucketName(env: string): string {',
    '  return `bucket-${env}`;',
    '}',
    '',
    'export function roleName(env: string) {',
    '  return `role-${env}`;',
    '}',
    '',
  ].join('\n'),
  ...project('alpha', 'alpha', ['dev', 'prod'], {
    'index.ts': [
      "import { bucketName } from '../lib/naming';",
      "import * as aws from '@pulumi/aws';",
      "export const bucket = new aws.s3.Bucket('b', { bucket: bucketName('dev') });",
      '',
    ].join('\n'),
  }),
  ...project('beta', 'beta', ['dev'], {
    'index.ts': [
      "import { roleName } from '../lib/naming';",
      "import * as aws from '@pulumi/aws';",
      "new aws.iam.Role('r', { name: roleName('dev'), assumeRolePolicy: '{}' });",
      '',
    ].join('\n'),
  }),
};

test('a change to a shared function selects only the projects that call it', () => {
  const result = selectChange(SHARED, {
    'lib/naming.ts': SHARED['lib/naming.ts'].replace('role-${env}', 'iam-role-${env}'),
  });
  assert.deepEqual(selectedIds(result), ['beta/dev']);
  assert.match(
    reasonsOf(result, 'beta/dev')[0],
    /lib\/naming\.ts: `roleName` changed \(via beta\/index\.ts\)/,
  );
});

test('every stack of an affected project is selected', () => {
  const result = selectChange(SHARED, {
    'lib/naming.ts': SHARED['lib/naming.ts'].replace('bucket-${env}', 'b-${env}'),
  });
  assert.deepEqual(selectedIds(result), ['alpha/dev', 'alpha/prod']);
});

test('comments, formatting and types are not changes', () => {
  const result = selectChange(SHARED, {
    'lib/naming.ts': [
      '/** Names buckets consistently */',
      'export function bucketName(env: "dev" | "prod"): `bucket-${string}` {',
      '  // one bucket per environment',
      '  return `bucket-${env}`',
      '}',
      'export function roleName(env: string): string { return `role-${env}`; }',
      '',
      'export interface Unused { name: string }',
      '',
    ].join('\n'),
  });
  assert.deepEqual(selectedIds(result), []);
});

test('a new function nobody calls selects nothing', () => {
  const result = selectChange(SHARED, {
    'lib/naming.ts': `${SHARED['lib/naming.ts']}export function topicName() { return 'topic'; }\n`,
  });
  assert.deepEqual(selectedIds(result), []);
});

test('code that runs when a module loads matters to every program that imports the module', () => {
  const before = {
    ...SHARED,
    'lib/naming.ts': `${SHARED['lib/naming.ts']}export const registry = new Map();\n`,
  };
  const result = selectChange(before, {
    'lib/naming.ts': `${SHARED['lib/naming.ts']}export const registry = new Map([['a', 1]]);\n`,
  });
  assert.deepEqual(selectedIds(result), ['alpha/dev', 'alpha/prod', 'beta/dev']);
  assert.match(reasonsOf(result, 'beta/dev')[0], /`registry` changed/);
});

test('changes reach a program through any number of modules', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import { makeBucket } from './storage';\nmakeBucket();\n",
    'storage.ts':
      "import { name } from './util/names';\nexport function makeBucket() { return name('x'); }\n",
    'util/names.ts': "export function name(s: string) { return s + '-1'; }\n",
  });
  const result = selectChange(before, {
    'util/names.ts': "export function name(s: string) { return s + '-2'; }\n",
  });
  assert.deepEqual(selectedIds(result), ['app/dev']);
  assert.match(
    reasonsOf(result, 'app/dev')[0],
    /util\/names\.ts: `name` changed \(via index\.ts → storage\.ts\)/,
  );
});

test('a module imported only for its types never loads, so its code does not matter', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts':
      "import { Settings } from './settings';\nconst s: Settings = { a: 1 };\nexport const a = s.a;\n",
    'settings.ts':
      'export interface Settings { a: number }\nexport const defaults = compute();\nfunction compute() { return 1; }\n',
  });
  const result = selectChange(before, {
    'settings.ts':
      'export interface Settings { a: number }\nexport const defaults = compute();\nfunction compute() { return 2; }\n',
  });
  assert.deepEqual(selectedIds(result), []);
});

test('namespace imports are precise when used as `ns.member`', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import * as names from './names';\nexport const x = names.used();\n",
    'names.ts': 'export function used() { return 1; }\nexport function unused() { return 1; }\n',
  });
  const unusedChange = selectChange(before, {
    'names.ts': 'export function used() { return 1; }\nexport function unused() { return 2; }\n',
  });
  assert.deepEqual(selectedIds(unusedChange), []);
  const usedChange = selectChange(before, {
    'names.ts': 'export function used() { return 2; }\nexport function unused() { return 1; }\n',
  });
  assert.deepEqual(selectedIds(usedChange), ['app/dev']);
});

test('a namespace passed around as a value depends on all its exports', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import * as names from './names';\nexport const all = Object.keys(names);\n",
    'names.ts': 'export function a() { return 1; }\nexport function b() { return 1; }\n',
  });
  const result = selectChange(before, {
    'names.ts': 'export function a() { return 1; }\nexport function b() { return 2; }\n',
  });
  assert.deepEqual(selectedIds(result), ['app/dev']);
});

test('re-exports through a barrel file stay precise', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import { a } from './lib';\nexport const x = a();\n",
    'lib/index.ts': "export * from './a';\nexport { b as renamed } from './b';\n",
    'lib/a.ts': 'export function a() { return 1; }\n',
    'lib/b.ts': 'export function b() { return 1; }\n',
  });
  const unrelated = selectChange(before, { 'lib/b.ts': 'export function b() { return 2; }\n' });
  assert.deepEqual(selectedIds(unrelated), []);
  const related = selectChange(before, { 'lib/a.ts': 'export function a() { return 2; }\n' });
  assert.deepEqual(selectedIds(related), ['app/dev']);
});

test('a lazy constant matters only when used', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import { REGION } from './constants';\nexport const region = REGION;\n",
    'constants.ts': "export const REGION = 'eu-west-2';\nexport const UNUSED = 'a';\n",
  });
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'constants.ts': "export const REGION = 'eu-west-2';\nexport const UNUSED = 'b';\n",
      }),
    ),
    [],
  );
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'constants.ts': "export const REGION = 'us-east-1';\nexport const UNUSED = 'a';\n",
      }),
    ),
    ['app/dev'],
  );
});

test("the entry file's exports are stack outputs, but its unused functions are not", () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "export const url = 'https://a';\nfunction helper() { return 1; }\n",
  });
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'index.ts': "export const url = 'https://b';\nfunction helper() { return 1; }\n",
      }),
    ),
    ['app/dev'],
  );
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'index.ts': "export const url = 'https://a';\nfunction helper() { return 2; }\n",
      }),
    ),
    [],
  );
});

test('functions called by a used function are followed', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import { outer } from './lib';\nouter();\n",
    'lib.ts':
      'export function outer() { return inner(); }\nfunction inner() { return 1; }\nfunction other() { return 1; }\n',
  });
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'lib.ts':
          'export function outer() { return inner(); }\nfunction inner() { return 2; }\nfunction other() { return 1; }\n',
      }),
    ),
    ['app/dev'],
  );
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'lib.ts':
          'export function outer() { return inner(); }\nfunction inner() { return 1; }\nfunction other() { return 2; }\n',
      }),
    ),
    [],
  );
});

test('tsconfig path aliases resolve to source', () => {
  const before = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } },
    }),
    'lib/names.ts': 'export function name() { return 1; }\n',
    ...project('app', 'app', ['dev'], {
      'index.ts': "import { name } from '@lib/names';\nname();\n",
    }),
  };
  const result = selectChange(before, { 'lib/names.ts': 'export function name() { return 2; }\n' });
  assert.deepEqual(selectedIds(result), ['app/dev']);
});

test('workspace packages resolve to their source', () => {
  const before = {
    'package.json': JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*', 'infra'],
    }),
    'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', main: 'dist/index.js' }),
    'packages/shared/src/index.ts':
      "export function tag() { return 'a'; }\nexport function other() { return 'a'; }\n",
    ...project('infra', 'infra', ['dev'], {
      'index.ts': "import { tag } from '@acme/shared';\ntag();\n",
    }),
  };
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'packages/shared/src/index.ts':
          "export function tag() { return 'b'; }\nexport function other() { return 'a'; }\n",
      }),
    ),
    ['infra/dev'],
  );
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'packages/shared/src/index.ts':
          "export function tag() { return 'a'; }\nexport function other() { return 'b'; }\n",
      }),
    ),
    [],
  );
});

test('JavaScript projects and CommonJS modules are analysed', () => {
  const before = project('', 'app', ['dev'], {
    'index.js': "const lib = require('./lib');\nlib.make();\n",
    'lib.js': 'module.exports = { make() { return 1; } };\n',
  });
  const result = selectChange(before, { 'lib.js': 'module.exports = { make() { return 2; } };\n' });
  assert.deepEqual(selectedIds(result), ['app/dev']);
});

test('decorators and enums count as code', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "import { Size } from './enums';\nexport const size = Size.Small;\n",
    'enums.ts': 'export enum Size { Small = 1, Large = 2 }\n',
  });
  const result = selectChange(before, {
    'enums.ts': 'export enum Size { Small = 3, Large = 2 }\n',
  });
  assert.deepEqual(selectedIds(result), ['app/dev']);
});

test('an import that cannot be analysed falls back to any change in the project folder', () => {
  const before = project('', 'app', ['dev'], {
    'index.ts': "const name = process.env.MODULE ?? './a';\nrequire(name);\n",
    'a.ts': 'export const a = 1;\n',
    'README.md': '# app\n',
  });
  const result = selectChange(before, { 'a.ts': 'export const a = 2;\n' });
  assert.deepEqual(selectedIds(result), ['app/dev']);
  assert.match(
    reasonsOf(result, 'app/dev')[0],
    /a\.ts changed \(.*require\(\) with a computed path/,
  );
  assert.ok(result.warnings.some((warning) => warning.includes('computed path')));
  assert.deepEqual(selectedIds(selectChange(before, { 'README.md': '# app!\n' })), []);
});

test('Pulumi.yaml changes select the project, except its description', () => {
  const before = project('', 'app', ['dev'], { 'index.ts': 'export const a = 1;\n' });
  assert.deepEqual(
    selectedIds(
      selectChange(before, { 'Pulumi.yaml': 'name: app\nruntime: nodejs\ndescription: hello\n' }),
    ),
    [],
  );
  assert.deepEqual(
    selectedIds(
      selectChange(before, {
        'Pulumi.yaml': 'name: app\nruntime:\n  name: nodejs\n  options:\n    typescript: false\n',
      }),
    ),
    ['app/dev'],
  );
});
