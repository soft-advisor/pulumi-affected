import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classify } from "../classify.js";
import { loadConfig } from "../config.js";
import { matchesAnyStack, matchesStack } from "../patterns.js";
import { errorText, isMissingStack, onCancel, parseLastJsonObject, } from "../pulumi/runner.js";
import { readOutputs, secretsProviderOf, stateFingerprint } from "../pulumi/stack.js";
import { readDependencyGraph, select, } from "../select.js";
import { git, repoRootOf, WorktreeSnapshot } from "../snapshot.js";
import { mapConcurrently } from "./concurrency.js";
import { describeRead, missingDeclaredOutputs, staleReads } from "./outputs.js";
import { planHasSecrets, stackOutputChanges, unknownOutputChanges } from "./planfile.js";
import { hashFile, planFileNames, writeManifest, } from "./manifest.js";
export async function planStacks(options) {
    const repoRoot = repoRootOf(options.select.cwd);
    const directory = resolve(options.directory);
    mkdirSync(directory, { recursive: true });
    const config = options.select.config ?? loadConfig(new WorktreeSnapshot(repoRoot));
    const selection = select({ ...options.select, config });
    if (options.mode !== 'preview')
        refuseForceUp(selection.forceUp);
    // Wave by wave, so a stack created to be planned exists before the stacks that reference it
    const outcomes = [];
    let failed = false;
    for (const wave of selection.waves) {
        const stacks = selection.stacks.filter((stack) => wave.includes(stack.id));
        outcomes.push(...(await mapConcurrently(stacks, options.concurrency, async (stack) => {
            const outcome = options.failFast && failed
                ? {
                    kind: 'failed',
                    id: stack.id,
                    error: 'not planned: an earlier stack failed (fail-fast)',
                    reasons: stack.reasons,
                }
                : await planStack(stack, {
                    ...options,
                    directory,
                    repoRoot,
                    ignore: config.classify.ignore,
                    createMode: createModeFor(stack, selection.createStacks, config, options),
                    references: () => referencedStacks(stack.id, repoRoot, config, selection.dependencies),
                });
            if (outcome.kind === 'failed')
                failed = true;
            options.onFinish?.(outcome);
            return outcome;
        })));
    }
    // A planned stack reading outputs another plan changes was planned with their old values: its
    // plan can only be right once the other is applied, so it belongs in a later change. A
    // preview only informs: `up` deploys it after the other, with the new values.
    const preview = options.mode === 'preview';
    const planned = outcomes.flatMap((outcome) => outcome.kind === 'planned' ? [outcome.stack] : []);
    const stale = staleReads(planned, selection.dependencies, selection.outputsRead);
    const blocked = new Map();
    for (const read of stale) {
        if (!preview && planned.some((stack) => stack.id === read.id)) {
            blocked.set(read.id, [...(blocked.get(read.id) ?? []), read]);
        }
    }
    for (const [index, outcome] of outcomes.entries()) {
        if (outcome.kind !== 'planned' || !blocked.has(outcome.stack.id))
            continue;
        rmSync(join(directory, outcome.stack.plan), { force: true });
        rmSync(join(directory, outcome.stack.preview), { force: true });
        const reads = (blocked.get(outcome.stack.id) ?? []).map(describeRead).join('; ');
        const dependencies = [
            ...new Set((blocked.get(outcome.stack.id) ?? []).map((read) => `\`${read.dependency}\``)),
        ].join(', ');
        outcomes[index] = {
            kind: 'failed',
            id: outcome.stack.id,
            reasons: outcome.stack.reasons,
            blockedBy: blocked.get(outcome.stack.id),
            error: `It changes, and it ${reads}. Its plan would be made with the old values. Change ${dependencies} first, then this stack in a later pull request; or leave it out of this one with Pulumi-Affected-Skip: ${outcome.stack.id}`,
        };
    }
    const warnings = [...selection.warnings];
    // Outputs dependsOn names must be ones the stack exports, now or once this is applied
    for (const outcome of outcomes) {
        const id = outcome.kind === 'planned' ? outcome.stack.id : outcome.id;
        if (outcome.kind === 'failed' || !selection.declaredOutputs[id])
            continue;
        const stack = selection.stacks.find((candidate) => candidate.id === id);
        if (!stack)
            continue;
        try {
            const current = Object.keys(await readOutputs(options.runner, stack));
            const planned = outcome.kind === 'planned' ? outcome.stack.outputs : [];
            warnings.push(...missingDeclaredOutputs(id, [...current, ...planned], selection.declaredOutputs));
        }
        catch {
            // Reading outputs is only for this check
        }
    }
    const changesOutputs = planned.filter((stack) => !blocked.has(stack.id) && stack.outputs.length > 0);
    if (changesOutputs.length > 0 && selection.unknownReaders.length > 0) {
        warnings.push(unknownReadersWarning(changesOutputs, selection.unknownReaders));
    }
    // Previews leave no plans behind: `up` doesn't use them
    if (preview) {
        for (const stack of planned) {
            rmSync(join(directory, stack.plan), { force: true });
            rmSync(join(directory, stack.preview), { force: true });
        }
    }
    const manifest = {
        version: 2,
        ...(preview ? { mode: 'preview' } : {}),
        tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim(),
        head: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
        base: selection.base,
        pulumiVersion: await pulumiVersion(options.runner),
        stacks: outcomes.flatMap((outcome) => (outcome.kind === 'planned' ? [outcome.stack] : [])),
        unchanged: outcomes.flatMap((outcome) => outcome.kind === 'unchanged' ? [{ id: outcome.id, reasons: outcome.reasons }] : []),
        failed: outcomes.flatMap((outcome) => outcome.kind === 'failed'
            ? [
                {
                    id: outcome.id,
                    error: outcome.error,
                    reasons: outcome.reasons,
                    ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
                },
            ]
            : []),
        skipped: selection.skipped,
        ...(selection.forceUp.length > 0 ? { forceUp: selection.forceUp } : {}),
        followUps: stale.filter((read) => !blocked.has(read.id)),
        dependencies: selection.dependencies,
        warnings,
    };
    writeManifest(directory, manifest);
    return manifest;
}
/**
 * When a stack that doesn't exist yet is created: a Pulumi-Affected-Create-Stacks line in the
 * change (the last one naming it), else the config's patterns (plan's first), else the
 * config's default, else the action's input, else when planning
 */
export function createModeFor(stack, requests, config, options) {
    const requested = requests.filter((request) => request.patterns.length === 0 ||
        request.patterns.some((pattern) => matchesStack(pattern, stack)));
    const last = requested.at(-1);
    if (last)
        return last.mode;
    if (matchesAnyStack(config.createStacks.plan, stack))
        return 'plan';
    if (matchesAnyStack(config.createStacks.apply, stack))
        return 'apply';
    return config.createStacks.default ?? options.createStacks ?? 'plan';
}
function referencedStacks(id, repoRoot, config, dependencies) {
    const wanted = new Set(dependencies[id] ?? []);
    if (wanted.size === 0)
        return [];
    return readDependencyGraph({ cwd: repoRoot, config }).stacks.filter((stack) => wanted.has(stack.id));
}
async function planStack(stack, context) {
    const files = planFileNames(stack.id);
    const planPath = join(context.directory, files.plan);
    const previewPath = join(context.directory, files.preview);
    const fail = (error) => {
        rmSync(planPath, { force: true });
        rmSync(previewPath, { force: true });
        return { kind: 'failed', id: stack.id, error, reasons: stack.reasons };
    };
    let fingerprint;
    let created = false;
    let createOnApply = false;
    let encryptionSalt;
    let secretsCarried = false;
    let preview;
    try {
        let current = await stateFingerprint(context.runner, stack);
        if (current.kind === 'missing' && context.createMode === 'apply') {
            createOnApply = true;
            const temporary = await previewInTemporaryBackend(context, stack, planPath);
            preview = temporary.result;
            encryptionSalt = temporary.salt;
            secretsCarried = temporary.secretsCarried;
        }
        else {
            if (current.kind === 'missing') {
                const init = await context.runner.run(stack, initArgs(context.repoRoot, stack.configFile));
                if (init.code !== 0)
                    return fail(`couldn't create the stack: ${errorText(init)}`);
                created = true;
                current = await stateFingerprint(context.runner, stack);
                if (current.kind !== 'exists') {
                    return fail("the stack still doesn't exist after creating it");
                }
            }
            fingerprint = current.fingerprint;
            writeSalt(join(context.repoRoot, stack.configFile), current.salt);
            preview = await context.runner.run(stack, previewArgs(planPath));
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    if (preview.code !== 0)
        return fail(errorText(preview));
    writeFileSync(previewPath, preview.stdout);
    let classification;
    let outputs;
    let unknownOutputs;
    try {
        classification = classify(preview.stdout, context.ignore);
        if (!existsSync(planPath))
            return fail('Pulumi wrote no plan file');
        // The preview doesn't show stack outputs that would change; the plan does
        const planText = readFileSync(planPath, 'utf8');
        outputs = stackOutputChanges(planText);
        unknownOutputs = unknownOutputChanges(planText);
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    // A preview only informs; `up` creates the stack with whatever it has
    const strict = context.mode !== 'preview';
    if (strict &&
        createOnApply &&
        !secretsCarried &&
        planHasSecrets(readFileSync(planPath, 'utf8'))) {
        return fail(`It doesn't exist yet, and it's created when applying (create-stacks: apply), but its plan holds secrets, which can only be carried to the real stack with passphrase secrets and PULUMI_CONFIG_PASSPHRASE set. Create it when planning with Pulumi-Affected-Create-Stacks: plan ${stack.id}`);
    }
    if (strict && createOnApply && classification.changes.length > 0) {
        const resources = classification.changes.map((change) => `${change.type} ${change.name}`);
        return fail(`It doesn't exist yet, and it's created when applying (create-stacks: apply), so the change that adds it must give it no resources; this one would create ${resources.length}: ${resources.slice(0, 10).join(', ')}${resources.length > 10 ? ', …' : ''}. Add the stack first, empty, and its resources in a later pull request; or create it when planning with Pulumi-Affected-Create-Stacks: plan ${stack.id}`);
    }
    // A new stack always has something to apply: creating it
    if (!classification.changed && outputs.length === 0 && !created && !createOnApply) {
        rmSync(planPath, { force: true });
        rmSync(previewPath, { force: true });
        return { kind: 'unchanged', id: stack.id, reasons: stack.reasons };
    }
    return {
        kind: 'planned',
        stack: {
            id: stack.id,
            project: stack.project,
            dir: stack.dir,
            stack: stack.stack,
            wave: stack.wave,
            ...(createOnApply ? { createOnApply } : { fingerprint }),
            created,
            encryptionSalt: created
                ? encryptionSaltOf(join(context.repoRoot, stack.configFile))
                : encryptionSalt,
            plan: files.plan,
            preview: files.preview,
            planHash: hashFile(planPath),
            counts: classification.counts,
            changes: classification.changes,
            outputs,
            ...(unknownOutputs.length > 0 ? { unknownOutputs } : {}),
            reasons: stack.reasons,
        },
    };
}
function previewArgs(planPath) {
    return ['preview', '--json', '--non-interactive', '--save-plan', planPath];
}
/** `stack init`, with the secrets provider the stack's config file names */
export function initArgs(repoRoot, configFile) {
    const path = join(repoRoot, configFile);
    const provider = secretsProviderOf(existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    return [
        'stack',
        'init',
        '--non-interactive',
        ...(provider ? ['--secrets-provider', provider] : []),
    ];
}
/**
 * Previews a stack that doesn't exist yet in a temporary local backend, so nothing is written to
 * the real one. The stacks it references are copied in from the real backend first, so a
 * program that reads them previews as it will run. Creating stacks there writes encryption
 * salts into their config files; those are restored afterwards.
 *
 * The command template runs with PULUMI_BACKEND_URL pointing at the temporary backend; before
 * anything is created, `pulumi whoami` through the template must report that backend, so a
 * wrapper that picks its own backend fails here instead of touching the real one.
 *
 * Secrets: the temporary stack uses passphrase secrets. When the stack really does too, and the
 * passphrase is set, its salt is returned so `apply` creates the real stack with it and the
 * plan's secrets decrypt. Otherwise a throwaway passphrase is used, and a plan holding secrets
 * fails, since nothing could decrypt them when applying.
 */
async function previewInTemporaryBackend(context, stack, planPath) {
    // One at a time: previews of new stacks that reference the same stack touch its config file
    return serially(async () => {
        const backend = mkdtempSync(join(tmpdir(), 'pulumi-affected-backend-'));
        const references = context.references();
        const configs = new Map();
        for (const target of [stack, ...references]) {
            const path = join(context.repoRoot, target.configFile);
            configs.set(path, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
        }
        const restore = () => {
            for (const [path, original] of configs) {
                if (original === undefined)
                    rmSync(path, { force: true });
                else
                    writeFileSync(path, original);
            }
            rmSync(backend, { recursive: true, force: true });
        };
        const unregister = onCancel(restore);
        const configPath = join(context.repoRoot, stack.configFile);
        const original = configs.get(configPath);
        const secretsCarried = secretsProviderOf(original) === undefined &&
            process.env.PULUMI_CONFIG_PASSPHRASE !== undefined;
        const env = {
            PULUMI_BACKEND_URL: `file://${backend}`,
            ...(secretsCarried ? {} : { PULUMI_CONFIG_PASSPHRASE: randomUUID() }),
        };
        const temporary = (target, args) => context.runner.run(target, args, env);
        const failed = (stderr) => ({
            result: { code: 1, stdout: '', stderr },
            secretsCarried,
        });
        try {
            // `about` takes --stack, which templates pass, and reports the backend even for a new stack
            const about = await temporary(stack, ['about', '--json']);
            const url = parseLastJsonObject(about.stdout)
                ?.backend?.url;
            if (!url || !sameFolder(url, backend)) {
                return failed(`the command template doesn't use the temporary backend it's given in PULUMI_BACKEND_URL (it reports ${url ?? 'nothing'}), so this stack can't be previewed without touching the real backend`);
            }
            for (const reference of references) {
                const exported = await context.runner.run(reference, ['stack', 'export']);
                if (isMissingStack(exported))
                    continue; // New too; the preview reports it if it's read
                if (exported.code !== 0)
                    return { result: exported, secretsCarried };
                const file = join(backend, `${reference.id.replace('/', '+')}.export.json`);
                writeFileSync(file, exported.stdout);
                const init = await temporary(reference, TEMPORARY_INIT);
                if (init.code !== 0)
                    return { result: init, secretsCarried };
                const imported = await temporary(reference, ['stack', 'import', '--file', file]);
                if (imported.code !== 0)
                    return { result: imported, secretsCarried };
            }
            // Its own config may name another secrets provider; here it's always a passphrase
            const init = await temporary(stack, TEMPORARY_INIT);
            if (init.code !== 0)
                return { result: init, secretsCarried };
            const stacks = join(backend, '.pulumi', 'stacks');
            const created = [
                join(stacks, stack.project, `${stack.stack}.json`),
                join(stacks, stack.project, `${stack.stack}.json.gz`),
                join(stacks, `${stack.stack}.json`),
                join(stacks, `${stack.stack}.json.gz`),
            ].some((path) => existsSync(path));
            if (!created)
                return failed("the stack wasn't created in the temporary backend");
            const salt = secretsCarried ? encryptionSaltOf(configPath) : undefined;
            const result = await temporary(stack, previewArgs(planPath));
            return { result, salt, secretsCarried };
        }
        finally {
            unregister();
            restore();
        }
    });
}
const TEMPORARY_INIT = ['stack', 'init', '--non-interactive'];
/** Whether a file:// backend URL names this folder */
function sameFolder(url, folder) {
    if (!url.startsWith('file://'))
        return false;
    const path = decodeURI(url.slice('file://'.length).split('?')[0]).replace(/\/+$/, '');
    try {
        return realpathSync(path) === realpathSync(folder);
    }
    catch {
        return false;
    }
}
let queue = Promise.resolve();
/** Runs tasks one after another */
function serially(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}
/**
 * Writes a passphrase stack's encryption salt into its config file when the file has none.
 * Pulumi only reads the salt from there, and makes a new one when it's missing, so a checkout
 * without the salt (one Pulumi wrote on another runner) couldn't decrypt the stack's secrets.
 */
export function writeSalt(configPath, salt) {
    // The state is trusted, but a salt is only ever one line of these characters
    if (!salt || !/^v1:[A-Za-z0-9+/=:]+$/.test(salt) || encryptionSaltOf(configPath) !== undefined) {
        return;
    }
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    if (secretsProviderOf(config) !== undefined)
        return;
    const separator = config === '' || config.endsWith('\n') ? '' : '\n';
    writeFileSync(configPath, `${config}${separator}encryptionsalt: ${salt}\n`);
}
/** The `encryptionsalt` in a stack's config file, if any */
export function encryptionSaltOf(path) {
    if (!existsSync(path))
        return undefined;
    try {
        const salt = parseYaml(readFileSync(path, 'utf8'))
            ?.encryptionsalt;
        return typeof salt === 'string' ? salt : undefined;
    }
    catch {
        return undefined;
    }
}
export async function pulumiVersion(runner) {
    const result = await runner.runPulumi(['version'], {});
    return result.code === 0 ? result.stdout.trim() : 'unknown';
}
/** That stacks whose references can't be analysed may need planning once outputs change */
export function unknownReadersWarning(changed, readers) {
    return `${changed.map((stack) => stack.id).join(', ')} change outputs, and ${readers.join(', ')} may read them in ways analysis can't see; plan those again after this is applied if they do, or declare what they read under dependsOn`;
}
/**
 * Plans apply exactly what they saved, and a stack whose plan shows no changes has none saved, so
 * a forced deploy can't work in this mode. Failing beats silently not deploying.
 */
export function refuseForceUp(forceUp) {
    if (forceUp.length === 0)
        return;
    throw new Error(`Pulumi-Affected-Force-Up (${forceUp.join(', ')}) only works with plan's mode preview and apply's mode up: in mode plan, apply applies exactly the saved plans, and a stack without changes has none`);
}
