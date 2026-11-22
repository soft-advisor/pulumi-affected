import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from "../config.js";
import { CycleError, computeWaves, dependentsOf } from "../graph.js";
import { matchesAnyStack } from "../patterns.js";
import { errorText } from "../pulumi/runner.js";
import { readOutputs, recentUpdates, stateFingerprint } from "../pulumi/stack.js";
import { readDependencyGraph, select } from "../select.js";
import { GitSnapshot, repoRootOf, resolveCommit } from "../snapshot.js";
import { mapConcurrently } from "./concurrency.js";
import { initArgs, unknownReadersWarning, writeSalt } from "./plan.js";
const RAN = new Set(['applied', 'unchanged']);
export async function upStacks(options) {
    const repoRoot = repoRootOf(options.cwd);
    const commit = resolveCommit(repoRoot, 'HEAD');
    const config = loadConfig(new GitSnapshot(repoRoot, commit));
    const selection = select({ ...options.select, cwd: repoRoot, head: commit, config });
    const { stacks: known, graph, outputsRead, unknownReaders, } = readDependencyGraph({
        cwd: repoRoot,
        head: commit,
        config,
    });
    const byId = new Map(known.map((stack) => [stack.id, stack]));
    const allowed = (id) => {
        const stack = byId.get(id);
        return stack !== undefined && (!options.allow || matchesAnyStack(options.allow, stack));
    };
    // Selected stacks to deploy, and why; the preview can only take some out
    const toRun = new Map();
    const results = new Map();
    for (const stack of selection.stacks) {
        if (options.previews?.unchanged.has(stack.id)) {
            results.set(stack.id, { id: stack.id, outcome: 'unchanged' });
        }
        else {
            toRun.set(stack.id, undefined);
        }
    }
    const warnings = [];
    const followUps = [];
    const changedOutputs = [];
    let failed = false;
    for (const wave of orderedWaves(graph, known.map((stack) => stack.id))) {
        const stacks = wave.filter((id) => toRun.has(id));
        await mapConcurrently(stacks, options.concurrency, async (id) => {
            const stack = byId.get(id);
            let result;
            if (!stack) {
                result = { id, outcome: 'failed', error: "it isn't a stack this commit defines" };
            }
            else if (!allowed(id)) {
                result = { id, outcome: 'failed', error: "it isn't one of the stacks allowed to deploy" };
            }
            else if (options.failFast && failed) {
                result = {
                    id,
                    outcome: 'skipped',
                    error: 'not tried: an earlier stack failed (fail-fast)',
                };
            }
            else {
                const blocked = [...(graph.get(id) ?? [])].filter((dependency) => {
                    const outcome = results.get(dependency)?.outcome;
                    return outcome !== undefined && !RAN.has(outcome);
                });
                result = blocked.length
                    ? { id, outcome: 'skipped', error: `not deployed: ${blocked.join(', ')}` }
                    : await upStack(stack, repoRoot, dependentsOf(graph, id).length > 0, options.runner);
            }
            const readsChanged = toRun.get(id);
            if (readsChanged)
                result.readsChanged = readsChanged;
            if (result.outcome === 'failed')
                failed = true;
            results.set(id, result);
            // Stacks reading outputs this update changed were deployed with the old values
            if (result.outputs?.length) {
                changedOutputs.push({ id });
                for (const dependent of dependentsOf(graph, id)) {
                    const reads = outputsRead[dependent]?.[id] ?? 'all';
                    const read = reads === 'all' ? result.outputs : result.outputs.filter((key) => reads.includes(key));
                    if (read.length === 0)
                        continue;
                    const stale = {
                        id: dependent,
                        dependency: id,
                        outputs: read,
                        certain: reads !== 'all',
                    };
                    if (options.outputReaders === 'up' && allowed(dependent)) {
                        // It comes in a later wave, as it depends on this stack
                        toRun.set(dependent, [...(toRun.get(dependent) ?? []), stale]);
                        if (results.get(dependent)?.outcome === 'unchanged')
                            results.delete(dependent);
                    }
                    else {
                        followUps.push(stale);
                    }
                }
            }
            options.onFinish?.(result);
        });
    }
    if (changedOutputs.length > 0 && unknownReaders.length > 0) {
        warnings.push(unknownReadersWarning(changedOutputs, unknownReaders));
    }
    const order = known.map((stack) => stack.id);
    const stacks = [...results.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return {
        stacks,
        followUps,
        warnings,
        ok: stacks.every((stack) => RAN.has(stack.outcome)),
    };
}
/** Waves over every stack, so readers of changed outputs come after what they read */
function orderedWaves(graph, ids) {
    try {
        return computeWaves(graph, ids);
    }
    catch (error) {
        if (!(error instanceof CycleError))
            throw error;
        return [...ids].sort().map((id) => [id]);
    }
}
async function upStack(stack, repoRoot, hasDependents, runner) {
    const fail = (error) => ({ id: stack.id, outcome: 'failed', error });
    try {
        const configPath = join(repoRoot, stack.configFile);
        const current = await stateFingerprint(runner, stack);
        if (current.kind === 'missing') {
            const init = await runner.run(stack, initArgs(repoRoot, stack.configFile));
            if (init.code !== 0)
                return fail(`couldn't create the stack: ${errorText(init)}`);
        }
        else {
            writeSalt(configPath, current.salt);
        }
        // Outputs are only compared for stacks others read
        const before = hasDependents ? await readOutputs(runner, stack) : undefined;
        const up = await runner.run(stack, ['up', '--yes', '--non-interactive', '--skip-preview']);
        if (up.code !== 0)
            return fail(errorText(up));
        const counts = (await recentUpdates(runner, stack, 1))[0]?.resourceChanges;
        const result = {
            id: stack.id,
            outcome: 'applied',
            ...(counts ? { counts } : {}),
        };
        if (before !== undefined) {
            const after = await readOutputs(runner, stack);
            const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
            const outputs = [...keys].filter((key) => !isDeepStrictEqual(before[key], after[key])).sort();
            if (outputs.length > 0)
                result.outputs = outputs;
        }
        return result;
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
