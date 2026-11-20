import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { configSchema } from '../src/schema.ts';

// The action runs this bundle straight from the repository, with no install step, so it's
// committed; CI checks it matches the source.
await build({
  entryPoints: ['src/action/select.ts'],
  outfile: 'select/dist/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync('schema.json', `${JSON.stringify(configSchema, null, 2)}\n`);
