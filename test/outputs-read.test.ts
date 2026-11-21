import assert from 'node:assert/strict';
import test from 'node:test';
import { readDependencyGraph } from '../src/select.ts';
import { createRepo, project } from './helpers.ts';

/** The outputs `app/prod` reads from `net/prod`, given app's index.ts and other files */
function readsOf(code: string, files: Record<string, string> = {}) {
  const { dir } = createRepo({
    ...project('net', 'net', ['prod'], { 'index.ts': 'export const vpcId = "vpc";\n' }),
    ...project('app', 'app', ['prod'], { 'index.ts': code, ...files }),
  });
  return readDependencyGraph({ cwd: dir }).outputsRead['app/prod']?.['net/prod'];
}

const header = "import * as pulumi from '@pulumi/pulumi';\n";

test('reads named with literals, on the reference or its constant', () => {
  assert.deepEqual(
    readsOf(
      `${header}const net = new pulumi.StackReference('organization/net/prod');\n` +
        "export const a = net.getOutput('vpcId');\n" +
        'export const b = net.requireOutputValue("subnets");\n' +
        'export const c = net.outputs.zone;\n' +
        "export const d = new pulumi.StackReference('organization/net/prod').getOutput('cidr');\n",
    ),
    ['cidr', 'subnets', 'vpcId', 'zone'],
  );
});

test('output names from constants, templates, imported constants and config', () => {
  assert.deepEqual(
    readsOf(
      `${header}import { OUTPUT } from './names';\n` +
        "const KIND = 'private';\n" +
        "const net = new pulumi.StackReference('organization/net/prod');\n" +
        'export const a = net.getOutput(`${KIND}Subnets`);\n' +
        'export const b = net.getOutput(OUTPUT);\n' +
        "export const c = net.getOutput(new pulumi.Config().require('output'));\n",
      {
        'names.ts': "export const OUTPUT = 'vpcId';\n",
        'Pulumi.prod.yaml': 'config:\n  app:output: zone\n',
      },
    ),
    ['privateSubnets', 'vpcId', 'zone'],
  );
});

test('a reference used in ways that could read any output reads all of them', () => {
  const ref = `${header}const net = new pulumi.StackReference('organization/net/prod');\n`;
  for (const use of [
    'export const a = net.getOutput(process.env.NAME!);\n',
    'export const a = net.outputs;\n',
    'export { net };\n',
    'function use(r: pulumi.StackReference) { return r; }\nexport const a = use(net);\n',
  ]) {
    assert.equal(readsOf(ref + use), 'all', use);
  }
  assert.equal(
    readsOf(`${header}export const net = new pulumi.StackReference('organization/net/prod');\n`),
    'all',
  );
});

const NET = "new pulumi.StackReference('organization/net/prod')";

test('followed across files: a reference exported and imported, by name or namespace', () => {
  assert.deepEqual(
    readsOf(
      `${header}import { network } from './refs';\nimport * as refs from './refs';\n` +
        "export const a = network.getOutput('vpcId');\n" +
        "export const b = refs.network.requireOutput('zone');\n",
      { 'refs.ts': `${header}export const network = ${NET};\n` },
    ),
    ['vpcId', 'zone'],
  );
});

test('followed into helpers: the names every call passes', () => {
  assert.deepEqual(
    readsOf(
      `${header}const net = ${NET};\n` +
        'const out = (name: string) => net.getOutput(name);\n' +
        "export const a = out('vpcId');\nexport const b = out(`zone`);\n",
    ),
    ['vpcId', 'zone'],
  );
  assert.deepEqual(
    readsOf(`${header}import { output } from './helpers';\nexport const a = output('cidr');\n`, {
      'helpers.ts': `${header}const net = ${NET};\nexport function output(name: 'cidr' | 'subnets') {\n  return net.getOutput(name);\n}\n`,
    }),
    // Typed as a union, but only ever called with one of them
    ['cidr'],
  );
});

test('followed into functions the reference is passed to', () => {
  assert.deepEqual(
    readsOf(`${header}import { subnets } from './lib';\nexport const a = subnets(${NET});\n`, {
      'lib.ts': `${header}export function subnets(ref: pulumi.StackReference) {\n  return ref.getOutput('privateSubnets');\n}\n`,
    }),
    ['privateSubnets'],
  );
});

test('still all when a helper is called with a name that cannot be known', () => {
  assert.equal(
    readsOf(
      `${header}const net = ${NET};\n` +
        'const out = (name: string) => net.getOutput(name);\n' +
        "export const a = out('vpcId');\nexport const b = out(process.env.NAME!);\n",
    ),
    'all',
  );
});

const REFS = { 'refs.ts': `${header}export const network = ${NET};\n` };

test('imports resolve as the analysis resolves them: tsconfig paths and #imports', () => {
  assert.deepEqual(
    readsOf(
      `${header}import { network } from '@lib/refs';\nexport const a = network.getOutput('secret');\n`,
      {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } },
        }),
        'lib/refs.ts': `${header}export const network = ${NET};\n`,
      },
    ),
    ['secret'],
  );
  assert.deepEqual(
    readsOf(
      `${header}import { network } from '#refs';\nexport const a = network.getOutput('secret');\n`,
      {
        'package.json': JSON.stringify({ name: 'app', imports: { '#refs': './refs.ts' } }),
        ...REFS,
      },
    ),
    ['secret'],
  );
});

test('references exported from a module loaded with require() or import() read all', () => {
  for (const code of [
    "const refs = require('./refs');\nexport const a = refs.network.getOutput('secret');\n",
    "export const a = import('./refs').then((m) => m.network.getOutput('secret'));\n",
  ]) {
    assert.equal(
      readsOf(
        `${header}import { network } from './refs';\nnetwork.getOutput('vpcId');\n${code}`,
        REFS,
      ),
      'all',
      code,
    );
  }
});

test('overloads, arguments and casts are never trusted', () => {
  const overloaded =
    `${header}import { network } from './refs';\n` +
    'function read(ref: pulumi.StackReference): pulumi.Output<any>;\n' +
    'function read(ref: pulumi.StackReference, name?: string) { return ref.getOutput(name ?? "secret"); }\n' +
    'export const a = read(network);\n';
  assert.equal(readsOf(overloaded, REFS), 'all');
  assert.equal(
    readsOf(
      `${header}import { network } from './refs';\nfunction read(ref: any) { return arguments[0].getOutput('secret'); }\nexport const a = read(network);\n`,
      REFS,
    ),
    'all',
  );
  assert.equal(
    readsOf(
      `${header}import { network } from './refs';\nexport const a = network.getOutput(process.env.X as 'vpcId');\n`,
      REFS,
    ),
    'all',
  );
});
