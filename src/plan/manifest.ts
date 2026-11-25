import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResourceChange } from '../classify.ts';
import type { StaleRead } from './outputs.ts';

/*
 * The plan directory's manifest: what `plan` planned and `apply` applies. It's the contract
 * between them, whatever moves the directory (an artifact, a cache, a bucket). The plan job ran
 * the pull request's code, which could have rewritten anything in the directory, so `apply`
 * checks the manifest's shape, every name and path, and each plan file's hash before trusting it,
 * and takes the order stacks apply in from the checked-out code, not from here.
 */

export const MANIFEST_FILE = 'manifest.json';
export const COMMENT_FILE = 'comment.md';
const MANIFEST_VERSION = 2;

export interface PlannedStack {
  id: string;
  project: string;
  /** Repo-relative folder; "" for the repository root */
  dir: string;
  stack: string;
  wave: number;
  /**
   * A hash of the stack's state when planned; applying refuses any other state. Absent for a
   * stack created on apply, which didn't exist when planned.
   */
  fingerprint?: string;
  /** Whether `plan` created the stack, empty, to plan it */
  created: boolean;
  /**
   * The stack didn't exist and is created when applying (`create-stacks: apply`). It was planned
   * in a temporary backend, and its plan creates no resources.
   */
  createOnApply?: boolean;
  /**
   * The passphrase encryption salt Pulumi wrote into the config file of a stack `plan` created.
   * The plan's secrets are encrypted with it, so `apply` restores it in a checkout without one.
   */
  encryptionSalt?: string;
  /** File names in the plan directory */
  plan: string;
  preview: string;
  /** sha256 of the plan file */
  planHash: string;
  counts: Record<string, number>;
  changes: ResourceChange[];
  /** Stack outputs the plan adds, changes or removes */
  outputs: string[];
  /** Of those, the ones whose new value is only known once applied */
  unknownOutputs?: string[];
  reasons: string[];
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  /**
   * `preview` when only previewed (plan's `mode: preview`): the plan files aren't kept, and the
   * manifest only tells `up` which stacks had changes
   */
  mode?: 'preview';
  /** The git tree that was planned: only exactly this code may apply the plans */
  tree: string;
  head: string;
  base: string;
  pulumiVersion: string;
  /** Plans to apply, with changes */
  stacks: PlannedStack[];
  /** Previewed, nothing to apply */
  unchanged: { id: string; reasons: string[] }[];
  /** Stacks that couldn't be planned; `blockedBy` when they read outputs another plan changes */
  failed: { id: string; error: string; reasons: string[]; blockedBy?: StaleRead[] }[];
  skipped: { id: string; source: string; reasons: string[] }[];
  /** Stacks a Pulumi-Affected-Force-Up line asks to deploy even without changes (mode preview) */
  forceUp?: string[];
  /** Stacks that read outputs these plans change, to plan again once they're applied */
  followUps: StaleRead[];
  /** Stack id → ids of the stacks it depends on, for the report */
  dependencies: Record<string, string[]>;
  warnings: string[];
}

/** File names for a stack's plan; `+` can't appear in project or stack names, so they're unique */
export function planFileNames(id: string) {
  const base = id.replace('/', '+');
  return { plan: `${base}.plan.json`, preview: `${base}.preview.json` };
}

export function hashFile(path: string) {
  return hashText(readFileSync(path));
}

export function hashText(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

export function writeManifest(directory: string, manifest: Manifest) {
  writeFileSync(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export class ManifestError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
/** Any relative folder, without control characters or backslashes */
const FOLDER = /^(?!\/)[^\\\p{Cc}]*$/u;
const FILE = /^[A-Za-z0-9_.+-]+\.json$/;
const SALT = /^v1:[A-Za-z0-9+/=:]+$/;

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
    `version ${manifest.version} isn't ${MANIFEST_VERSION}; plan again with this version`,
  );
  check(SHA.test(manifest.tree) && SHA.test(manifest.head), 'tree or head is not a SHA');
  check(
    Array.isArray(manifest.stacks) && Array.isArray(manifest.failed),
    'stacks or failed missing',
  );
  check(typeof manifest.pulumiVersion === 'string', 'pulumiVersion missing');
  check(
    manifest.mode === undefined,
    'these are previews, not plans: deploy them with the apply action in mode up',
  );
  check(Array.isArray(manifest.followUps), 'followUps missing');
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
    const files = planFileNames(stack.id);
    check(
      stack.plan === files.plan && stack.preview === files.preview,
      `unexpected file names for ${stack.id}`,
    );
    check(FILE.test(stack.plan), `bad plan file for ${stack.id}`);
    check(SHA256.test(stack.planHash), `bad plan hash for ${stack.id}`);
    check(
      stack.createOnApply === true
        ? stack.fingerprint === undefined && !stack.created
        : stack.createOnApply === undefined && SHA256.test(stack.fingerprint ?? ''),
      `bad fingerprint for ${stack.id}`,
    );
    check(
      stack.encryptionSalt === undefined || SALT.test(stack.encryptionSalt),
      `bad encryption salt for ${stack.id}`,
    );
    check(
      Array.isArray(stack.outputs) && stack.outputs.every((key) => typeof key === 'string'),
      `bad outputs for ${stack.id}`,
    );
    check(!ids.has(stack.id), `${stack.id} listed twice`);
    ids.add(stack.id);
    const planPath = join(directory, stack.plan);
    check(existsSync(planPath), `${stack.plan} is missing`);
    check(hashFile(planPath) === stack.planHash, `${stack.plan} doesn't match its hash`);
  }
  return manifest;
}

/** What a preview found, as `up` uses it: which stacks had changes, and which had none */
export interface PreviewSummary {
  changed: Set<string>;
  unchanged: Set<string>;
  /** The commit previewed, if the manifest names a well-formed one */
  head?: string;
  /** The tree previewed: the same tree is the same code */
  tree?: string;
}

/**
 * Reads a preview manifest (plan's `mode: preview`). It comes from the job that ran the pull
 * request's code, so it's only used to skip stacks it says had no changes; anything it leaves
 * out is deployed.
 */
export function readPreviewSummary(directory: string): PreviewSummary {
  const path = join(directory, MANIFEST_FILE);
  if (!existsSync(path)) throw new ManifestError(`No ${MANIFEST_FILE} in ${directory}`);
  let manifest: Partial<Manifest>;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} isn't JSON`);
  }
  const ids = (list: unknown) =>
    new Set(
      (Array.isArray(list) ? list : [])
        .map((entry) => (entry as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
  if (manifest?.mode !== 'preview') {
    throw new ManifestError(`${MANIFEST_FILE} isn't from a preview (plan's mode: preview)`);
  }
  const changed = ids(manifest.stacks);
  // Failing to preview isn't "no changes"
  const unchanged = ids(manifest.unchanged);
  for (const id of ids(manifest.failed)) unchanged.delete(id);
  for (const id of changed) unchanged.delete(id);
  const head =
    typeof manifest.head === 'string' && SHA.test(manifest.head) ? manifest.head : undefined;
  const tree =
    typeof manifest.tree === 'string' && SHA.test(manifest.tree) ? manifest.tree : undefined;
  return { changed, unchanged, ...(head ? { head } : {}), ...(tree ? { tree } : {}) };
}
