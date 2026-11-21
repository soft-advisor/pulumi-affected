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
