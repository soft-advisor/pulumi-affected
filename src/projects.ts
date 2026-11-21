import { parse } from 'yaml';
import type { Config } from './config.ts';
import { matchesAnyGlob } from './patterns.ts';
import { dirnameOf, joinPath, type Snapshot } from './snapshot.ts';

export interface Project {
  /** The `name` in Pulumi.yaml */
  name: string;
  /** Repo-relative folder holding Pulumi.yaml; "" for the repo root */
  dir: string;
  /** Path of Pulumi.yaml itself */
  file: string;
  runtime: string;
  /** The `main` option, relative to `dir`, if set */
  main: string | undefined;
  /** Folder holding Pulumi.<stack>.yaml files */
  stackConfigDir: string;
  stacks: Stack[];
}

export interface Stack {
  /** "<project name>/<stack>" */
  id: string;
  project: string;
  dir: string;
  stack: string;
  /** Path of Pulumi.<stack>.yaml, which may not exist yet */
  configFile: string;
}

const PROJECT_FILE = /(^|\/)Pulumi\.ya?ml$/;
const STACK_FILE = /^Pulumi\.(.+)\.ya?ml$/;

export class ProjectError extends Error {}

/*
 * Names reach shell commands and workflow expressions, so anything outside what Pulumi itself
 * accepts is left out with a warning rather than quoted and hoped for.
 */
/** Pulumi's own rule for project and stack names */
const NAME = /^[A-Za-z0-9_.-]+$/;
/** Folders: letters, digits, spaces and a few punctuation marks; no quotes, $, backticks or newlines */
const FOLDER = /^[A-Za-z0-9 _.@+/-]*$/;

/** Finds every Pulumi project in the snapshot and its stacks */
export function discoverProjects(
  snapshot: Snapshot,
  config: Config,
  warnings: string[] = [],
): Project[] {
  const projects: Project[] = [];
  const names = new Map<string, string>();
  for (const file of snapshot.paths) {
    if (!PROJECT_FILE.test(file) || file.split('/').includes('node_modules')) continue;
    const dir = dirnameOf(file);
    const dirForGlobs = dir === '' ? '.' : dir;
    // "**" means everywhere, including the root, which globs call "."
    const included =
      matchesAnyGlob(config.projects.include, dirForGlobs) ||
      (dir === '' && config.projects.include.includes('**'));
    if (!included) continue;
    if (matchesAnyGlob(config.projects.exclude, dirForGlobs)) continue;

    if (!FOLDER.test(dir)) {
      warnings.push(
        `${file} is in a folder whose name has characters that aren't safe in commands; skipped`,
      );
      continue;
    }
    const project = readProject(snapshot, file, warnings);
    if (!NAME.test(project.name)) {
      warnings.push(`${file}: project name "${project.name}" isn't a valid Pulumi name; skipped`);
      continue;
    }
    const sameName = names.get(project.name);
    if (sameName !== undefined) {
      throw new ProjectError(
        `Projects in "${sameName || '.'}" and "${dir || '.'}" are both named "${project.name}"; stack ids would be ambiguous`,
      );
    }
    names.set(project.name, dir);
    projects.push(project);
  }

  for (const extra of config.stacks) {
    const [projectRef, stack] = extra.split('/');
    const project = projects.find((p) => p.name === projectRef || (p.dir || '.') === projectRef);
    if (!project) throw new ProjectError(`stacks: no project matches "${projectRef}"`);
    if (!project.stacks.some((s) => s.stack === stack)) {
      project.stacks.push(makeStack(project, stack, `Pulumi.${stack}.yaml`));
    }
  }
  return projects.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Reads one project; `file` is the path of its Pulumi.yaml */
export function readProject(snapshot: Snapshot, file: string, warnings: string[] = []): Project {
  const dir = dirnameOf(file);
  const settings = parseProjectFile(snapshot.read(file) ?? '', file);
  const stackConfigDir = joinPath(dir, settings.stackConfigDir ?? '');
  const project: Project = {
    name: settings.name,
    dir,
    file,
    runtime: settings.runtime,
    main: settings.main,
    stackConfigDir,
    stacks: [],
  };
  for (const path of snapshot.paths) {
    if (dirnameOf(path) !== stackConfigDir) continue;
    const match = STACK_FILE.exec(path.slice(path.lastIndexOf('/') + 1));
    if (!match) continue;
    if (!NAME.test(match[1])) {
      warnings.push(`${path}: "${match[1]}" isn't a valid Pulumi stack name; skipped`);
      continue;
    }
    project.stacks.push(makeStack(project, match[1], match[0]));
  }
  project.stacks.sort((a, b) => a.stack.localeCompare(b.stack));
  return project;
}

function makeStack(project: Project, stack: string, fileName: string): Stack {
  return {
    id: `${project.name}/${stack}`,
    project: project.name,
    dir: project.dir,
    stack,
    configFile: joinPath(project.stackConfigDir, fileName),
  };
}

interface ProjectSettings {
  name: string;
  runtime: string;
  main?: string;
  stackConfigDir?: string;
}

export function parseProjectFile(text: string, file: string): ProjectSettings {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw.name !== 'string') {
    throw new ProjectError(`${file} has no project name`);
  }
  const runtime = raw.runtime;
  const runtimeName =
    typeof runtime === 'string'
      ? runtime
      : typeof runtime === 'object' && runtime !== null && 'name' in runtime
        ? String(runtime.name)
        : 'unknown';
  return {
    name: raw.name,
    runtime: runtimeName,
    main: typeof raw.main === 'string' ? raw.main : undefined,
    stackConfigDir: typeof raw.stackConfigDir === 'string' ? raw.stackConfigDir : undefined,
  };
}
