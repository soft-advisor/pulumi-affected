import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { errorText, isMissingStack, parseJsonArray, parseLastJsonObject, } from "./runner.js";
export class StackError extends Error {
}
function fingerprintOf(resources, pendingOperations) {
    return createHash('sha256')
        .update(JSON.stringify([resources ?? [], pendingOperations ?? []]))
        .digest('hex');
}
/** The fingerprint of a stack that holds nothing, as `stack init` leaves it */
export const EMPTY_FINGERPRINT = fingerprintOf([], []);
export async function stateFingerprint(runner, stack) {
    const result = await runner.run(stack, ['stack', 'export']);
    if (isMissingStack(result))
        return { kind: 'missing' };
    if (result.code !== 0)
        throw failure(stack, "can't export the stack's state", result);
    const exported = parseLastJsonObject(result.stdout);
    if (!exported)
        throw new StackError(`${stack.id}: the stack export isn't JSON`);
    // Resources and pending operations are the state; the export's own timestamps aren't
    const providers = exported?.deployment?.secrets_providers;
    const salt = providers?.type === 'passphrase' ? providers.state?.salt : undefined;
    return {
        kind: 'exists',
        fingerprint: fingerprintOf(exported?.deployment?.resources, exported?.deployment?.pending_operations),
        ...(typeof salt === 'string' ? { salt } : {}),
    };
}
/** The stack's newest history entries, newest first */
export async function recentUpdates(runner, stack, count = 25) {
    const result = await runner.run(stack, [
        'stack',
        'history',
        '--json',
        '--page-size',
        String(count),
    ]);
    if (result.code !== 0)
        throw failure(stack, "can't read the stack's history", result);
    const entries = parseJsonArray(result.stdout);
    if (!entries)
        throw new StackError(`${stack.id}: the stack history isn't JSON`);
    return entries;
}
/** Stack outputs including secrets, compared in memory only and never printed */
export async function readOutputs(runner, stack) {
    const result = await runner.run(stack, ['stack', 'output', '--json', '--show-secrets']);
    if (isMissingStack(result))
        return {};
    if (result.code !== 0)
        throw failure(stack, "can't read the stack's outputs", result);
    const parsed = parseLastJsonObject(result.stdout || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
}
/** The secrets provider a stack's config file names, other than the passphrase default */
export function secretsProviderOf(config) {
    if (!config)
        return undefined;
    try {
        const value = parseYaml(config)?.secretsprovider;
        return typeof value === 'string' && value !== 'passphrase' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function failure(stack, what, result) {
    return new StackError(`${stack.id}: ${what}: ${errorText(result)}`);
}
