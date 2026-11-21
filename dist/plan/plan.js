import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classify } from "../classify.js";
import { loadConfig } from "../config.js";
import { matchesAnyStack, matchesStack } from "../patterns.js";
import { errorText, onCancel } from "../pulumi/runner.js";
import { secretsProviderOf, stateFingerprint } from "../pulumi/stack.js";
import { readDependencyGraph, select, } from "../select.js";
import { git, repoRootOf, WorktreeSnapshot } from "../snapshot.js";
import { mapConcurrently } from "./concurrency.js";
import { describeRead, staleReads } from "./outputs.js";
import { stackOutputChanges, unknownOutputChanges } from "./planfile.js";
import { hashFile, planFileNames, writeManifest, } from "./manifest.js";
export async function planStacks(options) {
    const repoRoot = repoRootOf(options.select.cwd);
    const directory = resolve(options.directory);
    mkdirSync(directory, { recursive: true });
    const config = options.select.config ?? loadConfig(new WorktreeSnapshot(repoRoot));
    const selection = select({ ...options.select, config });
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
    // plan can only be right once the other is applied, so it belongs in a later change
    const planned = outcomes.flatMap((outcome) => outcome.kind === 'planned' ? [outcome.stack] : []);
    const stale = staleReads(planned, selection.dependencies, selection.outputsRead);
    const blocked = new Map();
    for (const read of stale) {
        if (planned.some((stack) => stack.id === read.id)) {
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
    const changesOutputs = planned.filter((stack) => !blocked.has(stack.id) && stack.outputs.length > 0);
    if (changesOutputs.length > 0 && selection.unknownReaders.length > 0) {
        warnings.push(unknownReadersWarning(changesOutputs, selection.unknownReaders));
    }
    const manifest = {
        version: 2,
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
    let preview;
    try {
        let current = await stateFingerprint(context.runner, stack);
        if (current.kind === 'missing' && context.createMode === 'apply') {
            createOnApply = true;
            preview = await previewInTemporaryBackend(context, stack, planPath);
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
    if (createOnApply && classification.changes.length > 0) {
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
                : undefined,
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
 * salts into their config files; those are restored afterwards. The command template runs with
 * PULUMI_BACKEND_URL pointing at the temporary backend, and the stack is checked to have been
 * created there, so a wrapper that picks its own backend fails instead of touching the real one.
 */
async function previewInTemporaryBackend(context, stack, planPath) {
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
    const env = { PULUMI_BACKEND_URL: `file://${backend}` };
    const temporary = (target, args) => context.runner.run(target, args, env);
    try {
        for (const reference of references) {
            const exported = await context.runner.run(reference, ['stack', 'export']);
            if (exported.code !== 0)
                continue; // Doesn't exist yet either
            const file = join(backend, `${reference.id.replace('/', '+')}.export.json`);
            writeFileSync(file, exported.stdout);
            const init = await temporary(reference, initArgs(context.repoRoot, reference.configFile));
            if (init.code !== 0)
                return init;
            const imported = await temporary(reference, ['stack', 'import', '--file', file]);
            if (imported.code !== 0)
                return imported;
        }
        const init = await temporary(stack, initArgs(context.repoRoot, stack.configFile));
        if (init.code !== 0)
            return init;
        if (!hasStackFile(join(backend, '.pulumi'), stack.stack)) {
            return {
                code: 1,
                stdout: '',
                stderr: `the stack wasn't created in the temporary backend: the command template must leave PULUMI_BACKEND_URL as it's given`,
            };
        }
        return await temporary(stack, previewArgs(planPath));
    }
    finally {
        unregister();
        restore();
    }
}
/** Whether a file backend holds a stack of this name */
function hasStackFile(folder, name) {
    if (!existsSync(folder))
        return false;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && hasStackFile(join(folder, entry.name), name))
            return true;
        if (entry.isFile() && (entry.name === `${name}.json` || entry.name === `${name}.json.gz`)) {
            return true;
        }
    }
    return false;
}
/**
 * Writes a passphrase stack's encryption salt into its config file when the file has none.
 * Pulumi only reads the salt from there, and makes a new one when it's missing, so a checkout
 * without the salt (one Pulumi wrote on another runner) couldn't decrypt the stack's secrets.
 */
export function writeSalt(configPath, salt) {
    if (!salt || encryptionSaltOf(configPath) !== undefined)
        return;
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
