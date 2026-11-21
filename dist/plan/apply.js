import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from "../config.js";
import { CycleError, computeWaves } from "../graph.js";
import { matchesAnyStack } from "../patterns.js";
import { errorText, onCancel } from "../pulumi/runner.js";
import { EMPTY_FINGERPRINT, recentUpdates, secretsProviderOf, stateFingerprint, } from "../pulumi/stack.js";
import { readDependencyGraph, select } from "../select.js";
import { GitSnapshot, git, repoRootOf, resolveCommit } from "../snapshot.js";
import { mapConcurrently } from "./concurrency.js";
import { hashText, readManifest } from "./manifest.js";
import { initArgs, pulumiVersion, unknownReadersWarning, writeSalt } from "./plan.js";
import { describeRead, staleReads } from "./outputs.js";
import { createsOnlyTheStack, relaxPlan, stackOutputChanges, unknownOutputChanges, } from "./planfile.js";
export class ApplyError extends Error {
}
/** Tags the update with the plan and the code it's for, so a rerun recognises it */
export function updateMessage(stack, tree) {
    return `pulumi-affected:${stack.planHash}:${tree}`;
}
const DONE = new Set(['applied', 'already-applied']);
export async function applyPlans(options) {
    const repoRoot = repoRootOf(options.cwd);
    const directory = resolve(options.directory);
    const manifest = readManifest(directory);
    if (manifest.failed.length > 0) {
        throw new ApplyError(`Planning failed for ${manifest.failed.map((stack) => stack.id).join(', ')}; plan again before applying`);
    }
    const tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
    if (tree !== manifest.tree) {
        throw new ApplyError(`The plans are for tree ${manifest.tree}, but the checkout is ${tree}; check out the planned code or plan again`);
    }
    // Stacks, their order and the config come from the commit, never from files beside it
    const commit = resolveCommit(repoRoot, 'HEAD');
    const config = loadConfig(new GitSnapshot(repoRoot, commit));
    const { stacks: known, graph, outputsRead, unknownReaders, } = readDependencyGraph({ cwd: repoRoot, head: commit, config });
    checkCheckout(repoRoot, directory, known);
    const byId = new Map(known.map((stack) => [stack.id, stack]));
    const selected = options.select
        ? new Set(select({ ...options.select, cwd: repoRoot, head: commit, config }).stacks.map((stack) => stack.id))
        : undefined;
    for (const stack of manifest.stacks) {
        const match = byId.get(stack.id);
        if (!match || match.dir !== stack.dir || match.stack !== stack.stack) {
            throw new ApplyError(`${stack.id} in the manifest isn't a stack this commit defines`);
        }
        if (selected && !selected.has(stack.id)) {
            throw new ApplyError(`${stack.id} has a plan, but this change doesn't select it`);
        }
        if (options.allow && !matchesAnyStack(options.allow, match)) {
            throw new ApplyError(`${stack.id} has a plan but isn't one of the stacks allowed to apply`);
        }
    }
    const warnings = [];
    const version = await pulumiVersion(options.runner);
    if (version !== manifest.pulumiVersion) {
        warnings.push(`Planned with Pulumi ${manifest.pulumiVersion}, applying with ${version}`);
    }
    // The outputs each plan changes, from the plan files themselves (their hashes were checked)
    const changes = manifest.stacks.map((stack) => ({
        id: stack.id,
        ...outputChanges(readFileSync(join(directory, stack.plan), 'utf8')),
    }));
    const planned = new Map(manifest.stacks.map((stack) => [stack.id, stack]));
    const stale = staleReads(changes, Object.fromEntries([...graph].map(([id, dependencies]) => [id, [...dependencies]])), outputsRead);
    const results = new Map();
    for (const wave of applyWaves(graph, [...planned.keys()])) {
        const stacks = wave.map((id) => planned.get(id));
        await mapConcurrently(stacks, options.concurrency, async (stack) => {
            const stopped = options.failFast && [...results.values()].some((done) => !DONE.has(done.outcome));
            const result = stopped
                ? {
                    id: stack.id,
                    outcome: 'skipped',
                    error: 'not tried: an earlier stack failed (fail-fast)',
                }
                : (blockedBy(stack, graph, planned, stale, results) ??
                    (await applyStack(stack, {
                        ...options,
                        directory,
                        repoRoot,
                        configFile: byId.get(stack.id)?.configFile ?? '',
                        ignore: config.classify.ignore,
                        tree,
                    })));
            results.set(stack.id, result);
            options.onFinish?.(result);
        });
    }
    const stacks = manifest.stacks.map((stack) => results.get(stack.id));
    const applied = (id) => DONE.has(results.get(id)?.outcome ?? 'failed');
    const changedOutputs = changes.filter((change) => change.outputs.length > 0 && applied(change.id));
    if (changedOutputs.length > 0 && unknownReaders.length > 0) {
        warnings.push(unknownReadersWarning(changedOutputs, unknownReaders));
    }
    // A stack reading outputs that an applied plan changed was planned (or deployed) without them
    const followUps = stale.filter((read) => applied(read.dependency) && !applied(read.id));
    return {
        manifest,
        stacks,
        needsPlan: [...new Set(followUps.map((read) => read.id))].sort(),
        followUps,
        warnings,
        ok: stacks.every((stack) => DONE.has(stack.outcome)),
    };
}
/** Waves of the planned stacks by the commit's dependencies; one stack at a time if they cycle */
function applyWaves(graph, ids) {
    try {
        return computeWaves(graph, ids);
    }
    catch (error) {
        if (!(error instanceof CycleError))
            throw error;
        return [...ids].sort().map((id) => [id]);
    }
}
/** Why a stack can't apply because of a planned stack it depends on */
function blockedBy(stack, graph, planned, stale, results) {
    const dependencies = [...(graph.get(stack.id) ?? [])].filter((id) => planned.has(id));
    // Only stacks already tried count: in a cycle, the other stacks come later
    const notApplied = dependencies.filter((id) => {
        const outcome = results.get(id)?.outcome;
        return outcome !== undefined && !DONE.has(outcome);
    });
    if (notApplied.length > 0) {
        return { id: stack.id, outcome: 'skipped', error: `not applied: ${notApplied.join(', ')}` };
    }
    // Its plan was made with outputs that have changed since; `plan` doesn't keep such plans
    const reads = stale.filter((read) => read.id === stack.id);
    if (reads.length > 0) {
        return {
            id: stack.id,
            outcome: 'skipped',
            error: `plan it again: it ${reads.map(describeRead).join('; ')}`,
        };
    }
    return undefined;
}
/**
 * The checkout must be the commit: nothing modified or added, except the plan directory and the
 * encryption salts Pulumi writes into stack config files
 */
function checkCheckout(repoRoot, directory, known) {
    const planFolder = relative(repoRoot, directory);
    const insidePlans = (path) => planFolder !== '' &&
        !planFolder.startsWith('..') &&
        !isAbsolute(planFolder) &&
        (path === planFolder || path.startsWith(`${planFolder}/`));
    const configFiles = new Set(known.map((stack) => stack.configFile));
    const split = (text) => text.split('\0').filter(Boolean);
    // Only new files may sit in the plan directory; it never covers files of the commit
    const changed = [
        ...split(git(repoRoot, ['diff', '--name-only', '-z', 'HEAD'])).filter((path) => !(configFiles.has(path) && onlySaltChanged(repoRoot, path))),
        ...split(git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])).filter((path) => !insidePlans(path)),
    ];
    if (changed.length > 0) {
        throw new ApplyError(`The checkout has files the commit doesn't: ${changed.join(', ')}; apply from a clean checkout`);
    }
}
/** Whether a config file differs from the commit's only in its encryption salt */
function onlySaltChanged(repoRoot, path) {
    const full = join(repoRoot, path);
    if (!existsSync(full))
        return false;
    let committed = '';
    try {
        committed = git(repoRoot, ['show', `HEAD:${path}`]);
    }
    catch {
        // Added since the commit
    }
    const withoutSalt = (text) => {
        const { encryptionsalt: _, ...rest } = (parseYaml(text) ?? {});
        // Pulumi drops an empty `config: {}` when it writes the salt
        const config = rest.config;
        if (config === null || (typeof config === 'object' && Object.keys(config).length === 0)) {
            delete rest.config;
        }
        return rest;
    };
    try {
        return isDeepStrictEqual(withoutSalt(committed), withoutSalt(readFileSync(full, 'utf8')));
    }
    catch {
        return false;
    }
}
async function applyStack(stack, context) {
    const { runner } = context;
    const message = updateMessage(stack, context.tree);
    const fail = (error) => ({ id: stack.id, outcome: 'failed', error });
    try {
        let current = await stateFingerprint(runner, stack);
        const refused = {
            id: stack.id,
            outcome: 'refused',
            error: "the stack's state changed since it was planned; plan it again",
        };
        if (stack.createOnApply) {
            // The manifest comes from the plan job; that the plan creates nothing is checked here
            const plan = readFileSync(join(context.directory, stack.plan), 'utf8');
            if (!createsOnlyTheStack(plan)) {
                return fail("it's created when applying, but its plan has resources; plan it again");
            }
            const configPath = join(context.repoRoot, context.configFile);
            if (current.kind === 'missing') {
                // With the salt the plan's secrets were encrypted with, if it carries any
                writeSalt(configPath, stack.encryptionSalt);
                const init = await runner.run(stack, initArgs(context.repoRoot, context.configFile));
                if (init.code !== 0)
                    return fail(`couldn't create the stack: ${errorText(init)}`);
                current = await stateFingerprint(runner, stack);
                if (current.kind === 'missing')
                    return fail("the stack still doesn't exist after creating it");
            }
            else if (await appliedBefore(stack, runner, message)) {
                return { id: stack.id, outcome: 'already-applied' };
            }
            else if (
            // Created by an earlier run that stopped before applying: still empty, never updated
            current.fingerprint !== EMPTY_FINGERPRINT ||
                (await recentUpdates(runner, stack)).length > 0) {
                return {
                    ...refused,
                    error: "it was created since it was planned, and isn't empty; plan it again",
                };
            }
            else {
                // Created by an earlier run of this plan: its salt is the one to use
                writeSalt(configPath, current.salt ?? stack.encryptionSalt);
            }
        }
        else {
            if (current.kind === 'missing')
                return fail('the stack no longer exists');
            if (await appliedBefore(stack, runner, message)) {
                return { id: stack.id, outcome: 'already-applied' };
            }
            if (current.fingerprint !== stack.fingerprint)
                return refused;
            restoreSalt(stack, current.salt, join(context.repoRoot, context.configFile));
        }
        // Checked again here: programs and wrappers that ran earlier in this job could change files
        const text = readFileSync(join(context.directory, stack.plan));
        if (hashText(text) !== stack.planHash)
            return fail(`${stack.plan} changed since it was checked`);
        const { text: plan, relaxed } = relaxPlan(text.toString('utf8'), context.ignore);
        const folder = mkdtempSync(join(tmpdir(), 'pulumi-affected-apply-'));
        const cleanup = () => rmSync(folder, { recursive: true, force: true });
        const unregister = onCancel(cleanup);
        try {
            const planPath = join(folder, 'plan.json');
            writeFileSync(planPath, plan);
            const up = await runner.run(stack, [
                'up',
                '--yes',
                '--non-interactive',
                '--skip-preview',
                '--plan',
                planPath,
                '--message',
                message,
            ]);
            const open = relaxed.length > 0 ? { relaxed } : {};
            if (up.code !== 0)
                return { ...fail(errorText(up)), ...open };
            return { id: stack.id, outcome: 'applied', ...open };
        }
        finally {
            unregister();
            cleanup();
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
/** Whether an update in the stack's recent history applied this plan */
async function appliedBefore(stack, runner, message) {
    const updates = await recentUpdates(runner, stack);
    return updates.some((update) => update.message === message && update.result === 'succeeded');
}
/**
 * Puts the stack's passphrase encryption salt into a checkout whose config file has none, as
 * Pulumi needs it there to decrypt the plan's secrets. The backend's own record of it is used;
 * the manifest's only for a stack `plan` created, whose state may not record one yet.
 */
function restoreSalt(stack, backendSalt, configPath) {
    writeSalt(configPath, backendSalt ?? (stack.created ? stack.encryptionSalt : undefined));
}
function outputChanges(plan) {
    return { outputs: stackOutputChanges(plan), unknownOutputs: unknownOutputChanges(plan) };
}
