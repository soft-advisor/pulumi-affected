import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** File names for a stack's plan; `+` can't appear in project or stack names, so they're unique */
export function planFileNames(id) {
    const base = id.replace('/', '+');
    return { plan: `${base}.plan.json`, preview: `${base}.preview.json` };
}
export function hashFile(path) {
    return hashText(readFileSync(path));
}
export function hashText(content) {
    return createHash('sha256').update(content).digest('hex');
}
export function writeManifest(directory, manifest) {
    writeFileSync(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}
export class ManifestError extends Error {
}
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
/** Any relative folder, without control characters or backslashes */
const FOLDER = /^(?!\/)[^\\\p{Cc}]*$/u;
const FILE = /^[A-Za-z0-9_.+-]+\.json$/;
const SALT = /^v1:[A-Za-z0-9+/=:]+$/;
/** Reads and checks a manifest, and the hash of every plan file it names */
export function readManifest(directory) {
    const path = join(directory, MANIFEST_FILE);
    if (!existsSync(path))
        throw new ManifestError(`No ${MANIFEST_FILE} in ${directory}`);
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new ManifestError(`${MANIFEST_FILE} isn't JSON`);
    }
    const check = (condition, what) => {
        if (!condition)
            throw new ManifestError(`${MANIFEST_FILE}: ${what}`);
    };
    check(manifest && typeof manifest === 'object', 'not an object');
    check(manifest.version === MANIFEST_VERSION, `version ${manifest.version} isn't ${MANIFEST_VERSION}; plan again with this version`);
    check(SHA.test(manifest.tree) && SHA.test(manifest.head), 'tree or head is not a SHA');
    check(Array.isArray(manifest.stacks) && Array.isArray(manifest.failed), 'stacks or failed missing');
    check(typeof manifest.pulumiVersion === 'string', 'pulumiVersion missing');
    check(manifest.mode === undefined, 'these are previews, not plans: deploy them with the apply action in mode up');
    check(Array.isArray(manifest.followUps), 'followUps missing');
    const ids = new Set();
    for (const stack of manifest.stacks) {
        check(NAME.test(stack.project) && NAME.test(stack.stack), `bad name in ${String(stack.id)}`);
        check(stack.id === `${stack.project}/${stack.stack}`, `id ${String(stack.id)} doesn't match`);
        check(typeof stack.dir === 'string' &&
            FOLDER.test(stack.dir) &&
            !stack.dir.split('/').includes('..'), `bad folder for ${stack.id}`);
        const files = planFileNames(stack.id);
        check(stack.plan === files.plan && stack.preview === files.preview, `unexpected file names for ${stack.id}`);
        check(FILE.test(stack.plan), `bad plan file for ${stack.id}`);
        check(SHA256.test(stack.planHash), `bad plan hash for ${stack.id}`);
        check(stack.createOnApply === true
            ? stack.fingerprint === undefined && !stack.created
            : stack.createOnApply === undefined && SHA256.test(stack.fingerprint ?? ''), `bad fingerprint for ${stack.id}`);
        check(stack.encryptionSalt === undefined || SALT.test(stack.encryptionSalt), `bad encryption salt for ${stack.id}`);
        check(Array.isArray(stack.outputs) && stack.outputs.every((key) => typeof key === 'string'), `bad outputs for ${stack.id}`);
        check(!ids.has(stack.id), `${stack.id} listed twice`);
        ids.add(stack.id);
        const planPath = join(directory, stack.plan);
        check(existsSync(planPath), `${stack.plan} is missing`);
        check(hashFile(planPath) === stack.planHash, `${stack.plan} doesn't match its hash`);
    }
    return manifest;
}
/**
 * Reads a preview manifest (plan's `mode: preview`). It comes from the job that ran the pull
 * request's code, so it's only used to skip stacks it says had no changes; anything it leaves
 * out is deployed.
 */
export function readPreviewSummary(directory) {
    const path = join(directory, MANIFEST_FILE);
    if (!existsSync(path))
        throw new ManifestError(`No ${MANIFEST_FILE} in ${directory}`);
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new ManifestError(`${MANIFEST_FILE} isn't JSON`);
    }
    const ids = (list) => new Set((Array.isArray(list) ? list : [])
        .map((entry) => entry?.id)
        .filter((id) => typeof id === 'string'));
    if (manifest?.mode !== 'preview') {
        throw new ManifestError(`${MANIFEST_FILE} isn't from a preview (plan's mode: preview)`);
    }
    const changed = ids(manifest.stacks);
    // Failing to preview isn't "no changes"
    const unchanged = ids(manifest.unchanged);
    for (const id of ids(manifest.failed))
        unchanged.delete(id);
    for (const id of changed)
        unchanged.delete(id);
    const head = typeof manifest.head === 'string' && SHA.test(manifest.head) ? manifest.head : undefined;
    const tree = typeof manifest.tree === 'string' && SHA.test(manifest.tree) ? manifest.tree : undefined;
    return { changed, unchanged, ...(head ? { head } : {}), ...(tree ? { tree } : {}) };
}
