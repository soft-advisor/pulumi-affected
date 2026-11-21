import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { configSchema } from "./schema.js";
export const CONFIG_FILE = 'pulumi-affected.yaml';
const DEFAULT_GLOBAL_INPUTS = ['.nvmrc', '.node-version'];
export function defaultConfig() {
    return {
        projects: { include: ['**'], exclude: [] },
        stacks: [],
        dependsOn: {},
        rules: [],
        always: [],
        inputs: {},
        globalInputs: [...DEFAULT_GLOBAL_INPUTS],
        packages: { ignore: [] },
        classify: { ignore: [] },
        createStacks: { plan: [], apply: [] },
    };
}
const validate = new Ajv({ allErrors: true }).compile(configSchema);
export class ConfigError extends Error {
}
/** Reads pulumi-affected.yaml from the snapshot's repo root; a missing file means defaults */
export function loadConfig(snapshot, path = CONFIG_FILE) {
    const text = snapshot.read(path);
    if (text === undefined)
        return defaultConfig();
    return parseConfig(text, path);
}
export function parseConfig(text, path = CONFIG_FILE) {
    const raw = parse(text) ?? {};
    if (!validate(raw)) {
        const problems = (validate.errors ?? [])
            .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
            .join('; ');
        throw new ConfigError(`${path} is invalid: ${problems}`);
    }
    const defaults = defaultConfig();
    const parsed = raw;
    return {
        projects: {
            include: parsed.projects?.include ?? defaults.projects.include,
            exclude: parsed.projects?.exclude ?? defaults.projects.exclude,
        },
        stacks: parsed.stacks ?? [],
        dependsOn: parsed.dependsOn ?? {},
        rules: parsed.rules ?? [],
        always: parsed.always ?? [],
        inputs: parsed.inputs ?? {},
        globalInputs: parsed.globalInputs ?? defaults.globalInputs,
        packages: { ignore: parsed.packages?.ignore ?? [] },
        classify: { ignore: parsed.classify?.ignore ?? [] },
        createStacks: {
            default: parsed.createStacks?.default,
            plan: parsed.createStacks?.plan ?? [],
            apply: parsed.createStacks?.apply ?? [],
        },
    };
}
