import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classify } from "../classify.js";
import { loadConfig } from "../config.js";
import { errorText } from "../pulumi/runner.js";
import { secretsProviderOf, stateFingerprint } from "../pulumi/stack.js";
import { select } from "../select.js";
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
    let preview;
    try {
        let current = await stateFingerprint(context.runner, stack);
        if (current.kind === 'missing') {
            const init = await context.runner.run(stack, initArgs(context.repoRoot, stack.configFile));
            if (init.code !== 0)
                return fail(`couldn't create the stack: ${errorText(init)}`);
            created = true;
            current = await stateFingerprint(context.runner, stack);
            if (current.kind !== 'exists')
                return fail("the stack still doesn't exist after creating it");
        }
        fingerprint = current.fingerprint;
        preview = await context.runner.run(stack, previewArgs(planPath));
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
    // A new stack always has something to apply: creating it
    if (!classification.changed && outputs.length === 0 && !created) {
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
            fingerprint,
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
