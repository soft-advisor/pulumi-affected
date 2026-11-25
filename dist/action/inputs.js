import { loadConfig } from "../config.js";
import { splitPatterns } from "../patterns.js";
import { eventContext } from "./context.js";
import { booleanInput, input, readEvent, warning } from "./github.js";
import { repoRootOf, WorktreeSnapshot } from "../snapshot.js";
/** Selection options from the action's inputs and the triggering event, shared by select and plan */
export function selectOptionsFromInputs() {
    const cwd = input('working-directory') || process.cwd();
    const repoRoot = repoRootOf(cwd);
    const event = readEvent();
    // An explicit base replaces what the event would say, so the event isn't read at all: it may
    // belong to another repository, as when a workflow selects in a checkout of its own
    const context = input('base')
        ? { base: undefined, messages: [], all: false, warnings: [] }
        : eventContext(event, repoRoot);
    for (const message of context.warnings)
        warning(message);
    const base = input('base') || context.base;
    if (!base && !booleanInput('all') && !context.all) {
        warning(`A ${event.name || 'local'} run has no revision to compare with, so only requested stacks are selected; set the base input`);
    }
    return {
        event,
        options: {
            cwd,
            base: base || 'HEAD',
            head: input('head') || undefined,
            bases: input('bases') ? JSON.parse(input('bases')) : undefined,
            run: splitPatterns(input('run')),
            skip: splitPatterns(input('skip')),
            forceUp: splitPatterns(input('force-up')),
            all: booleanInput('all') || context.all,
            messages: context.messages,
        },
    };
}
/** The pull request a run belongs to: the input, else the triggering pull request */
export function pullRequestNumber(event) {
    const explicit = input('pull-request');
    if (explicit) {
        const number = Number(explicit);
        if (!Number.isInteger(number) || number < 1)
            throw new Error(`pull-request "${explicit}" isn't a number`);
        return number;
    }
    const pullRequest = event.payload.pull_request;
    return typeof pullRequest?.number === 'number' ? pullRequest.number : undefined;
}
export function positiveInteger(name, fallback) {
    const value = input(name);
    if (!value)
        return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1)
        throw new Error(`${name} "${value}" isn't a positive whole number`);
    return number;
}
/** An input that must be one of `values` */
export function choice(name, values, fallback) {
    const value = input(name) || fallback;
    if (!values.includes(value)) {
        throw new Error(`${name} must be ${values.join(' or ')}, not "${value}"`);
    }
    return value;
}
/** The output-readers input, else the config's outputReaders, else up */
export function outputReaders(repoRoot) {
    if (input('output-readers'))
        return choice('output-readers', ['up', 'warn'], 'up');
    return loadConfig(new WorktreeSnapshot(repoRoot)).outputReaders ?? 'up';
}
