import { Ajv } from 'ajv';
import type { IgnoreRule } from './classify.ts';
import { parse } from 'yaml';
import { configSchema } from './schema.ts';
import type { Snapshot } from './snapshot.ts';

export const CONFIG_FILE = 'pulumi-affected.yaml';

export interface Config {
  projects: { include: string[]; exclude: string[] };
  stacks: string[];
  dependsOn: Record<string, string[]>;
  rules: { when: string[]; run: string[] }[];
  always: string[];
  inputs: Record<string, string[]>;
  globalInputs: string[];
  packages: { ignore: string[] };
  classify: { ignore: IgnoreRule[] };
  run: { command: string; concurrency: number; failFast: boolean; newStacks: 'preview' | 'skip' };
}

export const DEFAULT_COMMAND = 'pulumi --cwd {dir} --stack {stack}';

const DEFAULT_GLOBAL_INPUTS = ['.nvmrc', '.node-version'];

export function defaultConfig(): Config {
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
    run: { command: DEFAULT_COMMAND, concurrency: 4, failFast: false, newStacks: 'preview' },
  };
}

const validate = new Ajv({ allErrors: true }).compile(configSchema);

export class ConfigError extends Error {}

/** Reads pulumi-affected.yaml from the snapshot's repo root; a missing file means defaults */
export function loadConfig(snapshot: Snapshot, path = CONFIG_FILE): Config {
  const text = snapshot.read(path);
  if (text === undefined) return defaultConfig();
  return parseConfig(text, path);
}

export function parseConfig(text: string, path = CONFIG_FILE): Config {
  const raw = parse(text) ?? {};
  if (!validate(raw)) {
    const problems = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
      .join('; ');
    throw new ConfigError(`${path} is invalid: ${problems}`);
  }
  const defaults = defaultConfig();
  const parsed = raw as Partial<Omit<Config, 'run'>> & { run?: Partial<Config['run']> };
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
    run: {
      command: parsed.run?.command ?? defaults.run.command,
      concurrency: parsed.run?.concurrency ?? defaults.run.concurrency,
      failFast: parsed.run?.failFast ?? defaults.run.failFast,
      newStacks: parsed.run?.newStacks ?? defaults.run.newStacks,
    },
  };
}
