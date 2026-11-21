import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { evaluateString, WILDCARD } from './analysis/evaluate.ts';
import {
  analyzeProject,
  type Gap,
  type ModuleCache,
  type ProjectAnalysis,
} from './analysis/program.ts';
import { findUp, parseJson } from './analysis/resolve.ts';
import { type Config, loadConfig } from './config.ts';
import { addEdge, computeWaves, type DependencyGraph } from './graph.ts';
import {
  findLockfile,
  hasPackage,
  type LockGraph,
  LockfileError,
  packageClosure,
  readLockfile,
} from './lockfile.ts';
import { glob, matchesAnyGlob, matchesAnyStack, matchesStack, splitPatterns } from './patterns.ts';
import { discoverProjects, type Project, readProject, type Stack } from './projects.ts';
import {
  dirnameOf,
  GitSnapshot,
  git,
  isInside,
  joinPath,
  repoRootOf,
  resolveCommit,
  type Snapshot,
  WorktreeSnapshot,
} from './snapshot.ts';

export interface SelectOptions {
  /** Any folder inside the repository */
  cwd: string;
  /** The revision to compare against, e.g. the pull request's merge base */
  base: string;
  /** The revision to analyse; the working tree when omitted */
  head?: string;
  /**
   * Per-stack revisions to compare against instead of `base`, e.g. the commit each stack was
   * last deployed from. `null` means the stack was never deployed.
   */
  bases?: Record<string, string | null>;
  /** Stack patterns to select regardless of changes */
  run?: string[];
  /** Stack patterns to leave out unless also named in `run` */
  skip?: string[];
  /**
   * Honour Pulumi-Affected-Skip only from `skip`, not from commit messages or `messages`, which
   * anyone opening a pull request writes. Deploys use this: a skip there would hold a change back
   * until someone noticed.
   */
  trustedSkipsOnly?: boolean;
  /** Select every stack */
  all?: boolean;
  /** A reason to select a stack whatever changed, e.g. "its last deploy was from a dirty tree" */
  reasons?: Record<string, string>;
  /** Text that may carry Pulumi-Affected-Run/Skip lines, e.g. a pull request description */
  messages?: string[];
  /** Stack patterns to select, with who asked for them, e.g. a pull request comment command */
  requests?: Request[];
  config?: Config;
}

export interface SelectedStack extends Stack {
  /** Index of the wave this stack runs in */
  wave: number;
  reasons: string[];
}

export interface SelectResult {
  base: string;
  head: string;
  stacks: SelectedStack[];
  /** Selected stack ids grouped into waves that can run in parallel, in order */
  waves: string[][];
  /** Ids of stacks that weren't selected */
  unaffected: string[];
  /** Stacks a change affected but a Pulumi-Affected-Skip line or --skip left out */
  skipped: { id: string; source: string; reasons: string[] }[];
  /** Every stack id to the ids of the stacks it depends on */
  dependencies: Record<string, string[]>;
  warnings: string[];
}

export const RUN_TRAILER = 'Pulumi-Affected-Run';
export const SKIP_TRAILER = 'Pulumi-Affected-Skip';

/** How many reasons to list for one stack before summarizing the rest */
const MAX_REASONS = 8;

/** Files that never affect a program */
const IGNORED_FILES = ['**/*.md', '**/*.mdx', '**/LICENSE', '**/.gitignore'];

export function select(options: SelectOptions): SelectResult {
  const repoRoot = repoRootOf(options.cwd);
  const head: Snapshot = options.head
    ? new GitSnapshot(repoRoot, resolveCommit(repoRoot, options.head))
    : new WorktreeSnapshot(repoRoot);
  const config = options.config ?? loadConfig(head);
  const session = new Session(repoRoot, head, config);
  const defaultBase = resolveCommit(repoRoot, options.base);
  const warnings: string[] = [];
  const projects = discoverProjects(head, config, warnings);
  const stacks = projects.flatMap((project) => project.stacks);

  const reasons = new Map<string, string[]>();
  const addReason = (stack: Stack, reason: string) => {
    const list = reasons.get(stack.id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(stack.id, list);
  };

  // Each stack compares with its own base, so rules and trailers are read over its own range: a
  // stack whose last deploy failed still sees the commits since its last successful one
  const requestsByBase = new Map<string, ReturnType<typeof readRequests>>();
  const requestsFor = (base: string) => {
    let requests = requestsByBase.get(base);
    if (!requests) {
      requests = readRequests(repoRoot, base, options);
      requestsByBase.set(base, requests);
    }
    return requests;
  };
  const forced = new Set<string>();
  const skipped = new Map<string, string>();
  const unmatched = new Map<string, string>();

  for (const project of projects) {
    for (const stack of project.stacks) {
      const extra = options.reasons?.[stack.id];
      if (extra) addReason(stack, extra);
      const base = stackBase(options, stack, defaultBase, repoRoot);
      if (base === null) {
        addReason(stack, 'never deployed');
        continue;
      }
      for (const reason of session.projectReasons(project, base)) addReason(stack, reason);
      for (const reason of session.stackReasons(project, stack, base)) addReason(stack, reason);

      const changed = session.changedFiles(base);
      for (const rule of config.rules) {
        if (!matchesAnyStack(rule.run, stack)) continue;
        const trigger = [...changed.keys()].find((path) => matchesAnyGlob(rule.when, path));
        if (trigger) addReason(stack, `rule: ${trigger} changed`);
      }
      if (matchesAnyStack(config.always, stack)) addReason(stack, 'always selected (config)');

      const requests = requestsFor(base);
      for (const { pattern, source } of requests.run) {
        if (!unmatched.has(pattern)) unmatched.set(pattern, source);
        if (!matchesStack(pattern, stack)) continue;
        unmatched.set(pattern, '');
        addReason(stack, `requested by ${source}`);
        forced.add(stack.id);
      }
      const skip = requests.skip.find(
        ({ pattern, source }) =>
          matchesStack(pattern, stack) && (!options.trustedSkipsOnly || source === '--skip'),
      );
      if (skip) skipped.set(stack.id, skip.source);
    }
  }
  for (const [pattern, source] of unmatched) {
    if (source) warnings.push(`${source}: "${pattern}" matches no stack`);
  }
  // Skipped stacks stay visible, with who skipped them
  const skippedStacks: { id: string; source: string; reasons: string[] }[] = [];
  for (const [id, source] of skipped) {
    const list = reasons.get(id);
    if (forced.has(id) || !list) continue;
    skippedStacks.push({ id, source, reasons: list });
    reasons.delete(id);
  }
  warnings.push(...session.warnings);

  const graph = session.dependencyGraph(projects, stacks);
  warnings.push(...session.graphWarnings);
  const selectedIds = stacks.filter((stack) => reasons.has(stack.id)).map((stack) => stack.id);
  const waves = computeWaves(graph, selectedIds);
  const waveOf = new Map(waves.flatMap((wave, index) => wave.map((id) => [id, index] as const)));

  const selected: SelectedStack[] = [];
  for (const stack of stacks) {
    const list = reasons.get(stack.id);
    if (!list) continue;
    const shown = list.slice(0, MAX_REASONS);
    if (list.length > MAX_REASONS) shown.push(`and ${list.length - MAX_REASONS} more changes`);
    selected.push({ ...stack, wave: waveOf.get(stack.id) ?? 0, reasons: shown });
  }
  selected.sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));

  return {
    base: defaultBase,
    head: head.label,
    stacks: selected,
    waves,
    unaffected: stacks
      .filter(
        (stack) => !reasons.has(stack.id) && !skippedStacks.some((skip) => skip.id === stack.id),
      )
      .map((stack) => stack.id),
    skipped: skippedStacks,
    dependencies: Object.fromEntries(
      [...graph].map(([id, dependencies]) => [id, [...dependencies].sort()]),
    ),
    warnings: [...new Set(warnings)],
  };
}

function stackBase(options: SelectOptions, stack: Stack, defaultBase: string, repoRoot: string) {
  if (!options.bases || !(stack.id in options.bases)) return defaultBase;
  const base = options.bases[stack.id];
  return base === null ? null : resolveCommit(repoRoot, base);
}

/**
 * Holds snapshots and analyses for one selection, so each project is analysed once per
 * revision however many stacks it has.
 */
export class Session {
  readonly warnings: string[] = [];
  readonly graphWarnings: string[] = [];
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly analyses = new Map<string, ProjectAnalysis>();
  private readonly lockfiles = new Map<string, LockGraph | undefined>();
  private readonly changes = new Map<string, Map<string, string>>();
  private readonly projectReasonCache = new Map<string, string[]>();
  private readonly moduleCache: ModuleCache = new Map();
  private readonly repoRoot: string;
  readonly head: Snapshot;
  private readonly config: Config;

  constructor(repoRoot: string, head: Snapshot, config: Config) {
    this.repoRoot = repoRoot;
    this.head = head;
    this.config = config;
  }

  snapshot(commit: string) {
    let snapshot = this.snapshots.get(commit);
    if (!snapshot) {
      snapshot = new GitSnapshot(this.repoRoot, commit);
      this.snapshots.set(commit, snapshot);
    }
    return snapshot;
  }

  /** Paths whose content differs between `base` and head, with how they changed */
  changedFiles(base: string) {
    let changed = this.changes.get(base);
    if (!changed) {
      changed = new Map();
      const baseSnapshot = this.snapshot(base);
      for (const path of this.head.paths) {
        const before = baseSnapshot.hash(path);
        if (before === undefined) changed.set(path, 'added');
        else if (before !== this.head.hash(path)) changed.set(path, 'modified');
      }
      for (const path of baseSnapshot.paths) {
        if (!this.head.has(path)) changed.set(path, 'removed');
      }
      this.changes.set(base, changed);
    }
    return changed;
  }

  analysis(snapshot: Snapshot, project: Project) {
    const key = `${snapshot.label}\0${project.file}`;
    let analysis = this.analyses.get(key);
    if (!analysis) {
      analysis = analyzeProject(snapshot, project, this.moduleCache);
      this.analyses.set(key, analysis);
    }
    return analysis;
  }

  private lockfile(snapshot: Snapshot, path: string) {
    const key = `${snapshot.label}\0${path}`;
    if (!this.lockfiles.has(key)) {
      try {
        this.lockfiles.set(key, readLockfile(snapshot, path));
      } catch (error) {
        if (!(error instanceof LockfileError)) throw error;
        this.warnings.push(error.message);
        this.lockfiles.set(key, undefined);
      }
    }
    return this.lockfiles.get(key);
  }

  /** Why a project's program differs between `base` and head; empty when it doesn't */
  projectReasons(project: Project, base: string): string[] {
    const key = `${base}\0${project.file}`;
    let reasons = this.projectReasonCache.get(key);
    if (!reasons) {
      reasons = this.computeProjectReasons(project, base);
      this.projectReasonCache.set(key, reasons);
    }
    return reasons;
  }

  private computeProjectReasons(project: Project, base: string): string[] {
    const baseSnapshot = this.snapshot(base);
    if (!baseSnapshot.has(project.file)) return ['new project'];
    const changed = this.changedFiles(base);
    const reasons: string[] = [];

    for (const path of this.config.globalInputs) {
      for (const file of changed.keys()) {
        if (glob(path)(file)) reasons.push(`${file} changed`);
      }
    }
    if (
      !isDeepStrictEqual(
        projectSettings(baseSnapshot, project.file),
        projectSettings(this.head, project.file),
      )
    ) {
      reasons.push(`${project.file} changed`);
    }

    if (project.runtime !== 'nodejs') {
      this.warnings.push(
        `${project.name}: runtime "${project.runtime}" isn't analysed; any change in ${project.dir || 'the repo'} selects it (list other folders it reads under inputs)`,
      );
      return [
        ...reasons,
        ...this.folderChanges(
          project,
          changed,
          'not a Node.js project',
          yamlFileReferences(this.head, project),
        ),
      ];
    }

    const baseProject = readProject(baseSnapshot, project.file);
    const before = this.analysis(baseSnapshot, baseProject);
    const after = this.analysis(this.head, project);
    reasons.push(...describeFactChanges(before, after));
    const packages = this.packageChanges(project, baseSnapshot, before, after);
    reasons.push(...packages.reasons);

    const gaps = new Map<string, Gap>();
    for (const gap of [...after.gaps, ...before.gaps, ...packages.gaps]) {
      gaps.set(`${gap.dir}\0${gap.message}`, gap);
    }
    if (gaps.size > 0) {
      for (const gap of gaps.values()) this.warnings.push(`${project.name}: ${gap.message}`);
      const first = [...gaps.values()][0];
      reasons.push(
        ...this.folderChanges(
          project,
          changed,
          first.message,
          [...gaps.values()].map((gap) => gap.dir),
        ),
      );
    }
    return reasons;
  }

  /**
   * The fallback when analysis can't be complete: any change in the project's folder, or in the
   * folders where what analysis couldn't see most likely lives
   */
  private folderChanges(
    project: Project,
    changed: Map<string, string>,
    why: string,
    extraDirs: string[] = [],
  ) {
    const dirs = [project.dir, ...extraDirs];
    const files = [...changed.keys()].filter(
      (path) =>
        dirs.some((dir) => isInside(path, dir)) &&
        !matchesAnyGlob(IGNORED_FILES, path) &&
        !/(^|\/)Pulumi\.[^/]+\.ya?ml$/.test(path) &&
        !path.split('/').includes('node_modules'),
    );
    return files.map((file) => `${file} changed (${why}, so any change in that folder counts)`);
  }

  /**
   * Packages whose resolved identity (version, source, integrity, patch) differs between base and
   * head, among those the program loads and everything they depend on
   */
  private packageChanges(
    project: Project,
    baseSnapshot: Snapshot,
    before: ProjectAnalysis,
    after: ProjectAnalysis,
  ) {
    const gaps: Gap[] = [];
    const resolve = (snapshot: Snapshot, analysis: ProjectAnalysis) => {
      const path = findLockfile(snapshot, project.dir);
      const graph = path ? this.lockfile(snapshot, path) : undefined;
      const result = new Map<string, Set<string>>();
      if (!graph) return { result, path, graph };
      const roots = new Map(analysis.packages);
      // The Pulumi SDK runs every program, imported or not
      if (!roots.has('@pulumi/pulumi')) {
        roots.set('@pulumi/pulumi', new Set([analysis.entry ?? project.file]));
      }
      for (const [name, files] of analysis.packages) {
        if (!hasPackage(graph, name)) {
          const from = [...files][0];
          gaps.push({
            message: `${from} imports "${name}", which the lockfile doesn't resolve`,
            dir: dirnameOf(from),
          });
        }
      }
      const patches = patchFiles(snapshot, dirnameOf(graph.path));
      for (const id of packageClosure(graph, roots)) {
        const node = graph.nodes.get(id);
        if (!node || matchesAnyGlob(this.config.packages.ignore, node.name)) continue;
        const patch = patches.get(`${node.name}@${node.version}`) ?? patches.get(node.name);
        const identity = patch ? `${node.identity} patched ${patch}` : node.identity;
        const set = result.get(node.name) ?? new Set();
        set.add(identity);
        result.set(node.name, set);
      }
      return { result, path, graph };
    };
    const old = resolve(baseSnapshot, before);
    const current = resolve(this.head, after);
    const reasons: string[] = [];

    if (!old.path && !current.path) {
      // No lockfile: dependency ranges in the manifests are all there is to compare
      const manifestPath = findUp(this.head, project.dir, 'package.json');
      if (manifestPath) {
        const ranges = (snapshot: Snapshot) => dependencyRanges(snapshot.read(manifestPath));
        if (!isDeepStrictEqual(ranges(baseSnapshot), ranges(this.head))) {
          reasons.push(
            `${manifestPath} dependencies changed (there's no lockfile to narrow it down)`,
          );
        }
      }
      return { reasons, gaps };
    }
    if (!old.graph || !current.graph) {
      // An unreadable lockfile can't be narrowed down; any change to it counts
      const changed =
        old.path !== current.path ||
        (old.path !== undefined && baseSnapshot.hash(old.path) !== this.head.hash(old.path));
      if (changed) {
        reasons.push(`${current.path ?? old.path} changed (couldn't be read package by package)`);
      }
      return { reasons, gaps };
    }
    const names = new Set([...old.result.keys(), ...current.result.keys()]);
    for (const name of [...names].sort()) {
      const from = [...(old.result.get(name) ?? [])].sort();
      const to = [...(current.result.get(name) ?? [])].sort();
      if (from.join('\0') === to.join('\0')) continue;
      const label = (identities: string[]) =>
        identities.map((identity) => identity.split(' ')[0]).join(', ');
      if (from.length === 0) reasons.push(`package ${name} ${label(to)} added`);
      else if (to.length === 0) reasons.push(`package ${name} ${label(from)} removed`);
      else if (label(from) === label(to))
        reasons.push(`package ${name} ${label(to)} changed source or patch`);
      else reasons.push(`package ${name} ${label(from)} → ${label(to)}`);
    }
    return { reasons, gaps };
  }

  /** Why one stack, beyond its project, differs between `base` and head */
  stackReasons(project: Project, stack: Stack, base: string): string[] {
    const baseSnapshot = this.snapshot(base);
    const changed = this.changedFiles(base);
    const reasons: string[] = [];

    const before = parseYamlFile(baseSnapshot, stack.configFile);
    const after = parseYamlFile(this.head, stack.configFile);
    if (before === undefined && after !== undefined) reasons.push(`${stack.configFile} added`);
    else if (!isDeepStrictEqual(before, withoutNewSalt(before, after))) {
      reasons.push(`${stack.configFile} changed`);
    }

    // Force files: any edit at all, even whitespace, selects the stack
    for (const name of [`Pulumi.${stack.stack}.force`, 'Pulumi.force']) {
      const path = joinPath(project.stackConfigDir, name);
      if (changed.has(path) && this.head.has(path)) reasons.push(`${path} touched`);
    }

    for (const [pattern, globs] of Object.entries(this.config.inputs)) {
      if (!matchesStack(pattern, stack)) continue;
      for (const file of changed.keys()) {
        if (matchesAnyGlob(globs, file)) reasons.push(`${file} changed (inputs in config)`);
      }
    }
    return reasons;
  }

  /** Edges from stack references in code and from `dependsOn` in the config */
  dependencyGraph(projects: Project[], stacks: Stack[]): DependencyGraph {
    const graph: DependencyGraph = new Map();
    for (const project of projects) {
      if (project.runtime !== 'nodejs') continue;
      const analysis = this.analysis(this.head, project);
      for (const stack of project.stacks) {
        const stackConfig = parseYamlFile(this.head, stack.configFile) as
          | { config?: Record<string, unknown> }
          | undefined;
        const readConfig = (namespace: string, key: string) => {
          const values = stackConfig?.config ?? {};
          const value =
            values[`${namespace}:${key}`] ?? (namespace === project.name ? values[key] : undefined);
          return typeof value === 'string' ? value : undefined;
        };
        for (const { module, expression } of analysis.stackReferences) {
          const name = evaluateString(expression, module, {
            lookup: analysis.lookup,
            stack: stack.stack,
            project: project.name,
            config: readConfig,
            unknown: WILDCARD,
          });
          const targets = stacksNamed(name ?? WILDCARD, project, stacks);
          if (name === undefined || name === WILDCARD) {
            this.graphWarnings.push(
              `${stack.id}: a StackReference in ${module.path} has a name that can't be worked out; add it to dependsOn`,
            );
          }
          for (const target of targets) addEdge(graph, stack.id, target.id);
        }
      }
    }
    for (const [pattern, dependencies] of Object.entries(this.config.dependsOn)) {
      for (const stack of stacks) {
        if (!matchesStack(pattern, stack)) continue;
        for (const dependency of stacks) {
          if (matchesAnyStack(dependencies, dependency)) addEdge(graph, stack.id, dependency.id);
        }
      }
    }
    return graph;
  }
}

/**
 * Matches a referenced stack name ("org/project/stack", "project/stack" or "stack" in the same
 * project; unknown parts are "*") to stacks in this repo.
 */
function stacksNamed(name: string, project: Project, stacks: Stack[]) {
  if (name === WILDCARD) return [];
  const parts = name.split('/');
  const stackPart = parts[parts.length - 1];
  const projectPart = parts.length >= 2 ? parts[parts.length - 2] : project.name;
  return stacks.filter((stack) => glob(projectPart)(stack.project) && glob(stackPart)(stack.stack));
}

/** Pulumi.yaml settings that affect the program; a new description doesn't */
function projectSettings(snapshot: Snapshot, path: string) {
  const settings = parseYamlFile(snapshot, path);
  if (settings && typeof settings === 'object') {
    const { description: _description, ...rest } = settings as Record<string, unknown>;
    return rest;
  }
  return settings;
}

/**
 * Pulumi writes an encryption salt into a stack's config file when it creates the stack. A salt
 * that wasn't there before can't change what the program does, so it doesn't count; a changed
 * salt does.
 */
function withoutNewSalt(before: unknown, after: unknown) {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
  if (!isObject(before) || !isObject(after)) return after;
  if ('encryptionsalt' in before || !('encryptionsalt' in after)) return after;
  const { encryptionsalt: _salt, ...rest } = after;
  // Pulumi drops an empty `config: {}` when it rewrites the file
  if (!('config' in rest) && isObject(before.config) && Object.keys(before.config).length === 0) {
    rest.config = before.config;
  }
  return rest;
}

/**
 * Parses YAML keeping every scalar as written: Pulumi reads config values as strings, so 1.10
 * and 1.1, or two long numbers that round to the same double, are different values
 */
function parseYamlFile(snapshot: Snapshot, path: string): unknown {
  const text = snapshot.read(path);
  if (text === undefined) return undefined;
  try {
    return parseYaml(text, { schema: 'failsafe' }) ?? {};
  } catch {
    return text;
  }
}

/**
 * Folders a Pulumi YAML program reads files from (fn::readFile, fn::fileAsset, fn::fileArchive),
 * which may be outside the project folder
 */
function yamlFileReferences(snapshot: Snapshot, project: Project) {
  if (project.runtime !== 'yaml') return [];
  const text = snapshot.read(project.file) ?? '';
  const dirs: string[] = [];
  for (const match of text.matchAll(
    /fn::(?:readFile|fileAsset|fileArchive)\s*:\s*["']?([^\s"'#]+)/g,
  )) {
    const path = joinPath(project.dir, match[1]);
    dirs.push(snapshot.isDirectory(path) ? path : dirnameOf(path));
  }
  return dirs;
}

/** Patch files (patch-package's patches/<name>+<version>.patch) by the package they patch */
function patchFiles(snapshot: Snapshot, root: string) {
  const patches = new Map<string, string>();
  const dir = joinPath(root, 'patches');
  for (const path of snapshot.paths) {
    if (dirnameOf(path) !== dir || !path.endsWith('.patch')) continue;
    // "@scope+name+1.2.3.patch" → "@scope/name@1.2.3"
    const parts = path.slice(dir.length + 1, -'.patch'.length).split('+');
    const version = parts.pop() ?? '';
    const name = parts.join('/');
    const hash = snapshot.hash(path) ?? '';
    patches.set(`${name}@${version}`, hash);
    patches.set(name, hash);
  }
  return patches;
}

function dependencyRanges(text: string | undefined) {
  const manifest = parseJson(text) ?? {};
  const ranges: Record<string, unknown> = {};
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions',
  ]) {
    ranges[field] = manifest[field];
  }
  return ranges;
}

/** Turns differing facts into readable reasons */
export function describeFactChanges(before: ProjectAnalysis, after: ProjectAnalysis) {
  const keys = new Set([...before.facts.keys(), ...after.facts.keys()]);
  const reasons: string[] = [];
  const changedModules = new Set<string>();
  for (const key of [...keys].sort()) {
    const old = before.facts.get(key);
    const current = after.facts.get(key);
    if (old === current) continue;
    const [kind, ...rest] = key.split(':');
    const subject = rest.join(':');
    if (kind === 'code') {
      // "<path>#<name>", or "<path>##<hash>" for a statement that declares nothing
      const separator = subject.indexOf('#');
      const path = subject.slice(0, separator);
      const item = subject.slice(separator + 1);
      changedModules.add(path);
      const isStatement = item.startsWith('#');
      const what = isStatement ? 'a top-level statement' : `\`${item}\``;
      const how =
        old === undefined
          ? isStatement
            ? 'added'
            : 'now used'
          : current === undefined
            ? isStatement
              ? 'removed'
              : 'no longer used'
            : 'changed';
      const chain = (after.chains.get(path) ?? before.chains.get(path) ?? []).slice(0, -1);
      const via = chain.length > 0 ? ` (via ${chain.join(' → ')})` : '';
      reasons.push(`${path}: ${what} ${how}${via}`);
    } else if (kind === 'order') {
      if (!changedModules.has(subject) && old !== undefined && current !== undefined) {
        reasons.push(`${subject}: top-level statements reordered`);
      }
    } else if (kind === 'asset') {
      reasons.push(
        `file ${subject} ${old === undefined ? 'now read' : current === undefined ? 'no longer read' : 'changed'}`,
      );
    } else if (kind === 'compilerOptions') {
      reasons.push('TypeScript compiler options that affect the output changed');
    } else if (kind === 'entry') {
      reasons.push(`entry file changed from ${old} to ${current}`);
    } else if (kind === 'manifest') {
      reasons.push(`${subject}: type, main, imports or exports changed`);
    }
  }
  return reasons;
}

export interface Request {
  pattern: string;
  /** Who or what asked, shown as the reason: "requested by <source>" */
  source: string;
}

/** Pulumi-Affected-Run/Skip lines in commit messages between base and head, and in `messages` */
function readRequests(repoRoot: string, base: string, options: SelectOptions) {
  const run: Request[] = [];
  const skip: Request[] = [];
  const scan = (text: string, source: string) => {
    for (const line of text.split('\n')) {
      const match = /^\s*(Pulumi-Affected-(?:Run|Skip))\s*:\s*(.+)$/i.exec(line);
      if (!match) continue;
      const list = match[1].toLowerCase() === RUN_TRAILER.toLowerCase() ? run : skip;
      for (const pattern of splitPatterns(match[2])) list.push({ pattern, source });
    }
  };

  const headRev = options.head ?? 'HEAD';
  const log = git(repoRoot, ['log', '--format=%h%x00%B%x01', `${base}..${headRev}`]);
  for (const entry of log.split('\u0001')) {
    const [sha, body] = entry.trim().split('\u0000');
    if (body) scan(body, `commit ${sha}`);
  }
  for (const message of options.messages ?? []) scan(message, 'the pull request');
  run.push(...(options.requests ?? []));

  if (options.all) run.push({ pattern: 'all', source: '--all' });
  for (const pattern of options.run ?? []) run.push({ pattern, source: '--run' });
  for (const pattern of options.skip ?? []) skip.push({ pattern, source: '--skip' });
  return { run, skip };
}

/** The stacks in the repo and how they depend on each other, as of `head` */
export function readDependencyGraph(options: { cwd: string; head?: string; config?: Config }) {
  const repoRoot = repoRootOf(options.cwd);
  const head: Snapshot = options.head
    ? new GitSnapshot(repoRoot, resolveCommit(repoRoot, options.head))
    : new WorktreeSnapshot(repoRoot);
  const config = options.config ?? loadConfig(head);
  const session = new Session(repoRoot, head, config);
  const projects = discoverProjects(head, config);
  const stacks = projects.flatMap((project) => project.stacks);
  const graph = session.dependencyGraph(projects, stacks);
  return { stacks, graph, warnings: session.graphWarnings };
}
