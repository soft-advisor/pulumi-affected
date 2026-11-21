import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { classify, formatCounts } from '../classify.ts';
import { loadConfig } from '../config.ts';
import { glob, splitPatterns } from '../patterns.ts';
import { code, safeText } from '../render.ts';
import { repoRootOf, WorktreeSnapshot } from '../snapshot.ts';
import { appendSummary, error, input, setOutput } from './github.ts';

/*
 * The `classify` action: reads the JSON `pulumi preview --json` printed for each stack and says
 * which would change anything, so a workflow can drop the plans that wouldn't. Known noise is
 * ignored through classify.ignore in pulumi-affected.yaml.
 */

function main() {
  const cwd = input('working-directory') || process.cwd();
  const files = expand(splitPatterns(input('previews')), cwd);
  // Nothing selected means nothing previewed; that isn't an error
  const config = loadConfig(new WorktreeSnapshot(repoRootOf(cwd)));

  const changed: string[] = [];
  const unchanged: string[] = [];
  const rows = ['| Preview | Result |', '| --- | --- |'];
  for (const file of files) {
    const classification = classify(readFileSync(join(cwd, file), 'utf8'), config.classify.ignore);
    (classification.changed ? changed : unchanged).push(file);
    rows.push(`| ${code(file)} | ${safeText(formatCounts(classification))} |`);
  }
  appendSummary(
    `### pulumi-affected classify: ${changed.length} of ${files.length} would change\n\n${rows.join('\n')}`,
  );
  setOutput('changed', JSON.stringify(changed));
  setOutput('unchanged', JSON.stringify(unchanged));
  setOutput('any', changed.length > 0 ? 'true' : 'false');
  console.log(`Changes: ${changed.join(', ') || 'none'}`);
}

/** Paths relative to `cwd` matching the globs, which may reach into folders */
function expand(patterns: string[], cwd: string) {
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const fixed = pattern.slice(
      0,
      pattern.search(/[*?[{]/) === -1 ? pattern.length : pattern.search(/[*?[{]/),
    );
    const root = resolve(cwd, fixed.slice(0, fixed.lastIndexOf('/') + 1) || '.');
    const matcher = glob(pattern);
    for (const file of walk(root)) {
      const path = relative(cwd, file);
      if (matcher(path)) matches.add(path);
    }
  }
  return [...matches].sort();
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

try {
  main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
}
