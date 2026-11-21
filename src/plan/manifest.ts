import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResourceChange } from '../classify.ts';

/*
 * The plan directory's manifest: what `plan` planned and `apply` applies. It's the contract
 * between them, whatever moves the directory (an artifact, a cache, a bucket). The plan job ran
 * the pull request's code, which could have rewritten anything in the directory, so `apply`
 * checks the manifest's shape, every name and path, and each plan file's hash before trusting it.
 */

export const MANIFEST_FILE = 'manifest.json';
export const COMMENT_FILE = 'comment.md';
const MANIFEST_VERSION = 1;

export interface PlannedStack {
  id: string;
  project: string;
  /** Repo-relative folder; "" for the repository root */
  dir: string;
  stack: string;
  wave: number;
  /** The stack's state when planned, or that it didn't exist yet and is created when applying */
  state: { kind: 'exists'; fingerprint: string } | { kind: 'created-on-apply' };
  /** Whether `plan` created the stack, empty, to plan it */
  created: boolean;
  /** File names in the plan directory */
  plan: string;
  preview: string;
  /** sha256 of the plan file */
  planHash: string;
  counts: Record<string, number>;
  changes: ResourceChange[];
  /** Kept without resource changes because other stacks read its outputs */
  keptForDependents: boolean;
  reasons: string[];
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  /** The git tree that was planned: only exactly this code may apply the plans */
  tree: string;
  head: string;
  base: string;
  pulumiVersion: string;
  /** Plans to apply, with changes */
  stacks: PlannedStack[];
  /** Previewed, nothing to apply */
  unchanged: { id: string; reasons: string[] }[];
  failed: { id: string; error: string; reasons: string[] }[];
  skipped: { id: string; source: string; reasons: string[] }[];
  /** Stack id → ids of the stacks it depends on */
  dependencies: Record<string, string[]>;
  warnings: string[];
}

export function planFileNames(id: string) {
  const base = id.replace('/', '__');
  return { plan: `${base}.plan.json`, preview: `${base}.preview.json` };
}

export function hashFile(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeManifest(directory: string, manifest: Manifest) {
  writeFileSync(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export class ManifestError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const FOLDER = /^[A-Za-z0-9 _.@+/-]*$/;
const FILE = /^[A-Za-z0-9_.-]+\.json$/;

/** Reads and checks a manifest, and the hash of every plan file it names */
export function readManifest(directory: string): Manifest {
  const path = join(directory, MANIFEST_FILE);
  if (!existsSync(path)) throw new ManifestError(`No ${MANIFEST_FILE} in ${directory}`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} isn't JSON`);
  }
  const check = (condition: unknown, what: string) => {
    if (!condition) throw new ManifestError(`${MANIFEST_FILE}: ${what}`);
  };
  check(manifest && typeof manifest === 'object', 'not an object');
  check(
    manifest.version === MANIFEST_VERSION,
    `version ${manifest.version} isn't ${MANIFEST_VERSION}`,
  );
  check(SHA.test(manifest.tree) && SHA.test(manifest.head), 'tree or head is not a SHA');
  check(
    Array.isArray(manifest.stacks) && Array.isArray(manifest.failed),
    'stacks or failed missing',
  );
  check(manifest.dependencies && typeof manifest.dependencies === 'object', 'dependencies missing');
  const ids = new Set<string>();
  for (const stack of manifest.stacks) {
    check(NAME.test(stack.project) && NAME.test(stack.stack), `bad name in ${String(stack.id)}`);
    check(stack.id === `${stack.project}/${stack.stack}`, `id ${String(stack.id)} doesn't match`);
    check(
      typeof stack.dir === 'string' &&
        FOLDER.test(stack.dir) &&
        !stack.dir.split('/').includes('..'),
      `bad folder for ${stack.id}`,
    );
    check(Number.isInteger(stack.wave) && stack.wave >= 0, `bad wave for ${stack.id}`);
    const files = planFileNames(stack.id);
    check(
      stack.plan === files.plan && stack.preview === files.preview,
      `unexpected file names for ${stack.id}`,
    );
    check(FILE.test(stack.plan), `bad plan file for ${stack.id}`);
    check(SHA256.test(stack.planHash), `bad plan hash for ${stack.id}`);
    const state = stack.state;
    check(
      (state?.kind === 'exists' && SHA256.test(state.fingerprint)) ||
        state?.kind === 'created-on-apply',
      `bad state for ${stack.id}`,
    );
    check(!ids.has(stack.id), `${stack.id} listed twice`);
    ids.add(stack.id);
    const planPath = join(directory, stack.plan);
    check(existsSync(planPath), `${stack.plan} is missing`);
    check(hashFile(planPath) === stack.planHash, `${stack.plan} doesn't match its hash`);
  }
  return manifest;
}
