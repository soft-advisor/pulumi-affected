import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { type Files, selectChange, selectedIds } from './helpers.ts';

/*
 * The scenarios in e2e/scenarios.json, run against the fixtures in e2e/fixtures. The same
 * scenarios run end to end on GitHub; here they run against a local git repository.
 */

const E2E = join(import.meta.dirname, '../e2e');

interface Scenario {
  name: string;
  changes: Files;
  packageManager?: string;
  changesFrom?: Record<string, string>;
  /** The commit message of the change, for Pulumi-Affected-Run/Skip lines */
  message?: string;
  expected: string[];
  skipped?: string[];
  waves?: string[][];
}

function readTree(root: string, dir = root): Files {
  const files: Files = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(path).isDirectory()) Object.assign(files, readTree(root, path));
    else files[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return files;
}

const fixtures = readTree(join(E2E, 'fixtures'));
const scenarios: Scenario[] = JSON.parse(readFileSync(join(E2E, 'scenarios.json'), 'utf8'));

for (const scenario of scenarios) {
  test(`scenario: ${scenario.name}`, () => {
    // The same files the e2e driver uses: a package manager's base in place of npm's, and changes
    // taken from e2e/package-managers
    const base: Files = { ...fixtures };
    if (scenario.packageManager && scenario.packageManager !== 'npm') {
      base['package-lock.json'] = null;
      delete base['package-lock.json'];
      Object.assign(base, readTree(join(E2E, 'package-managers', scenario.packageManager, 'base')));
    }
    const changes: Files = { ...scenario.changes };
    for (const [path, from] of Object.entries(scenario.changesFrom ?? {})) {
      changes[path] = readFileSync(join(E2E, 'package-managers', from), 'utf8');
    }
    const result = selectChange(base, changes, { message: scenario.message });
    assert.deepEqual(selectedIds(result), scenario.expected);
    assert.deepEqual(
      result.skipped.map((skip) => skip.id),
      scenario.skipped ?? [],
    );
    if (scenario.waves) assert.deepEqual(result.waves, scenario.waves);
    assert.deepEqual(result.warnings, []);
  });
}
