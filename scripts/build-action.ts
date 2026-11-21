import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { configSchema } from '../src/schema.ts';

// The actions run these bundles straight from the repository, with no install step, so they're
// committed; CI checks they match the source.
for (const action of ['select', 'run']) {
  await build({
    entryPoints: [`src/action/${action}.ts`],
    outfile: `${action}/dist/index.cjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'none',
    // About a third of the size; the source is in the repository for reading
    minify: true,
    logLevel: 'warning',
  });
}

writeFileSync('schema.json', `${JSON.stringify(configSchema, null, 2)}\n`);
