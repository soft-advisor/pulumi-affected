import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { evaluateString, WILDCARD } from "./analysis/evaluate.js";
import { analyzeProject, } from "./analysis/program.js";
import { ProgramReferences } from "./analysis/references.js";
import { findUp, parseJson } from "./analysis/resolve.js";
import { loadConfig } from "./config.js";
import { addEdge, CycleError, computeWaves } from "./graph.js";
import { findLockfile, hasPackage, LockfileError, packageClosure, readLockfile, } from "./lockfile.js";
import { glob, matchesAnyGlob, matchesAnyStack, matchesStack, splitPatterns } from "./patterns.js";
import { discoverProjects, readProject } from "./projects.js";
import { dirnameOf, GitSnapshot, git, isInside, joinPath, repoRootOf, resolveCommit, WorktreeSnapshot, } from "./snapshot.js";
export const RUN_TRAILER = 'Pulumi-Affected-Run';
export const SKIP_TRAILER = 'Pulumi-Affected-Skip';
/** How many reasons to list for one stack before summarizing the rest */
const MAX_REASONS = 8;
/** Files that never affect a program */
const IGNORED_FILES = ['**/*.md', '**/*.mdx', '**/LICENSE', '**/.gitignore'];
export function select(options) {
    const repoRoot = repoRootOf(options.cwd);
    const head = options.head
        ? new GitSnapshot(repoRoot, resolveCommit(repoRoot, options.head))
        : new WorktreeSnapshot(repoRoot);
    const config = options.config ?? loadConfig(head);
    const session = new Session(repoRoot, head, config);
    const defaultBase = resolveCommit(repoRoot, options.base);
    const warnings = [];
    const projects = discoverProjects(head, config, warnings);
    const stacks = projects.flatMap((project) => project.stacks);
    const reasons = new Map();
    const addReason = (stack, reason) => {
        const list = reasons.get(stack.id) ?? [];
        if (!list.includes(reason))
            list.push(reason);
        reasons.set(stack.id, list);
    };
    // Each stack compares with its own base, so rules and trailers are read over its own range: a
    // stack whose last deploy failed still sees the commits since its last successful one
    const requestsByBase = new Map();
    const requestsFor = (base) => {
        let requests = requestsByBase.get(base);
        if (!requests) {
            requests = readRequests(repoRoot, base, options);
            requestsByBase.set(base, requests);
        }
        return requests;
    };
    const forced = new Set();
    const skipped = new Map();
    const unmatched = new Map();
    for (const project of projects) {
        for (const stack of project.stacks) {
            const base = stackBase(options, stack, defaultBase, repoRoot);
            if (base === null) {
                addReason(stack, 'never deployed');
                continue;
            }
            for (const reason of session.projectReasons(project, base))
                addReason(stack, reason);
            for (const reason of session.stackReasons(project, stack, base))
                addReason(stack, reason);
            const changed = session.changedFiles(base);
            for (const rule of config.rules) {
                if (!matchesAnyStack(rule.run, stack))
                    continue;
                const trigger = [...changed.keys()].find((path) => matchesAnyGlob(rule.when, path));
                if (trigger)
                    addReason(stack, `rule: ${trigger} changed`);
            }
            if (matchesAnyStack(config.always, stack))
                addReason(stack, 'always selected (config)');
            const requests = requestsFor(base);
            for (const { pattern, source } of requests.run) {
                if (!unmatched.has(pattern))
                    unmatched.set(pattern, source);
                if (!matchesStack(pattern, stack))
                    continue;
                unmatched.set(pattern, '');
                addReason(stack, `requested by ${source}`);
                forced.add(stack.id);
            }
            const skip = requests.skip.find(({ pattern }) => matchesStack(pattern, stack));
            if (skip)
                skipped.set(stack.id, skip.source);
        }
    }
    for (const [pattern, source] of unmatched) {
        if (source)
            warnings.push(`${source}: "${pattern}" matches no stack`);
    }
    // Skipped stacks stay visible, with who skipped them
    const skippedStacks = [];
    for (const [id, source] of skipped) {
        const list = reasons.get(id);
        if (forced.has(id) || !list)
            continue;
        skippedStacks.push({ id, source, reasons: list });
        reasons.delete(id);
    }
    warnings.push(...session.warnings);
    const graph = session.dependencyGraph(projects, stacks);
    warnings.push(...session.graphWarnings);
    const selectedIds = stacks.filter((stack) => reasons.has(stack.id)).map((stack) => stack.id);
    let waves;
    try {
        waves = computeWaves(graph, selectedIds);
    }
    catch (error) {
        if (!(error instanceof CycleError))
            throw error;
        // Run them all together rather than not at all; dependsOn can break the tie
        warnings.push(`${error.message}; they run in one wave`);
        waves = selectedIds.length > 0 ? [[...selectedIds].sort()] : [];
    }
    const waveOf = new Map(waves.flatMap((wave, index) => wave.map((id) => [id, index])));
    const selected = [];
    for (const stack of stacks) {
        const list = reasons.get(stack.id);
        if (!list)
            continue;
        const shown = list.slice(0, MAX_REASONS);
        if (list.length > MAX_REASONS)
            shown.push(`and ${list.length - MAX_REASONS} more changes`);
        selected.push({ ...stack, wave: waveOf.get(stack.id) ?? 0, reasons: shown });
    }
    selected.sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
    return {
        base: defaultBase,
        head: head.label,
        stacks: selected,
        waves,
        unaffected: stacks
            .filter((stack) => !reasons.has(stack.id) && !skippedStacks.some((skip) => skip.id === stack.id))
            .map((stack) => stack.id),
        skipped: skippedStacks,
        dependencies: Object.fromEntries([...graph].map(([id, dependencies]) => [id, [...dependencies].sort()])),
        outputsRead: session.outputsReadRecord(),
        unknownReaders: [...session.unknownReaders].sort(),
        createStacks: requestsFor(defaultBase).create,
        warnings: [...new Set(warnings)],
    };
}
function stackBase(options, stack, defaultBase, repoRoot) {
    if (!options.bases || !(stack.id in options.bases))
        return defaultBase;
    const base = options.bases[stack.id];
    return base === null ? null : resolveCommit(repoRoot, base);
}
/**
 * Holds snapshots and analyses for one selection, so each project is analysed once per
 * revision however many stacks it has.
 */
export class Session {
    warnings = [];
    graphWarnings = [];
    /** Stacks that may read other stacks' outputs in ways analysis can't see */
    unknownReaders = new Set();
    /** Stack id → dependency id → outputs read, filled in by dependencyGraph */
    outputsRead = new Map();
    recordReads(stack, dependency, outputs) {
        if (stack === dependency)
            return;
        const reads = this.outputsRead.get(stack) ?? new Map();
        this.outputsRead.set(stack, reads);
        const current = reads.get(dependency) ?? new Set();
        if (current === 'all' || outputs === 'all')
            reads.set(dependency, 'all');
        else
            reads.set(dependency, new Set([...current, ...outputs]));
    }
    outputsReadRecord() {
        return Object.fromEntries([...this.outputsRead].map(([stack, reads]) => [
            stack,
            Object.fromEntries([...reads].map(([dependency, outputs]) => [
                dependency,
                outputs === 'all' ? 'all' : [...outputs].sort(),
            ])),
        ]));
    }
    snapshots = new Map();
    analyses = new Map();
    lockfiles = new Map();
    changes = new Map();
    projectReasonCache = new Map();
    moduleCache = new Map();
    repoRoot;
    head;
    config;
    constructor(repoRoot, head, config) {
        this.repoRoot = repoRoot;
        this.head = head;
        this.config = config;
    }
    snapshot(commit) {
        let snapshot = this.snapshots.get(commit);
        if (!snapshot) {
            snapshot = new GitSnapshot(this.repoRoot, commit);
            this.snapshots.set(commit, snapshot);
        }
        return snapshot;
    }
    /** Paths whose content differs between `base` and head, with how they changed */
    changedFiles(base) {
        let changed = this.changes.get(base);
        if (!changed) {
            changed = new Map();
            const baseSnapshot = this.snapshot(base);
            for (const path of this.head.paths) {
                const before = baseSnapshot.hash(path);
                if (before === undefined)
                    changed.set(path, 'added');
                else if (before !== this.head.hash(path))
                    changed.set(path, 'modified');
            }
            for (const path of baseSnapshot.paths) {
                // hash, not has: links and submodules are entries too, not just files
                if (this.head.hash(path) === undefined)
                    changed.set(path, 'removed');
            }
            this.changes.set(base, changed);
        }
        return changed;
    }
    references = new Map();
    /** The head program of a project, for following stack references across modules */
    programReferences(project, analysis) {
        let references = this.references.get(project.file);
        if (!references) {
            const files = new Map();
            for (const path of analysis.modules) {
                const text = this.head.read(path);
                if (text !== undefined)
                    files.set(path, text);
            }
            references = new ProgramReferences(files, analysis.entry, analysis.resolveFile);
            this.references.set(project.file, references);
        }
        return references;
    }
    analysis(snapshot, project) {
        const key = `${snapshot.label}\0${project.file}`;
        let analysis = this.analyses.get(key);
        if (!analysis) {
            analysis = analyzeProject(snapshot, project, this.moduleCache);
            this.analyses.set(key, analysis);
        }
        return analysis;
    }
    lockfile(snapshot, path) {
        const key = `${snapshot.label}\0${path}`;
        if (!this.lockfiles.has(key)) {
            try {
                this.lockfiles.set(key, readLockfile(snapshot, path));
            }
            catch (error) {
                if (!(error instanceof LockfileError))
                    throw error;
                this.warnings.push(error.message);
                this.lockfiles.set(key, undefined);
            }
        }
        return this.lockfiles.get(key);
    }
    /** Why a project's program differs between `base` and head; empty when it doesn't */
    projectReasons(project, base) {
        const key = `${base}\0${project.file}`;
        let reasons = this.projectReasonCache.get(key);
        if (!reasons) {
            reasons = this.computeProjectReasons(project, base);
            this.projectReasonCache.set(key, reasons);
        }
        return reasons;
    }
    computeProjectReasons(project, base) {
        const baseSnapshot = this.snapshot(base);
        if (!baseSnapshot.has(project.file))
            return ['new project'];
        const changed = this.changedFiles(base);
        const reasons = [];
        for (const path of this.config.globalInputs) {
            for (const file of changed.keys()) {
                if (glob(path)(file))
                    reasons.push(`${file} changed`);
            }
        }
        if (!isDeepStrictEqual(projectSettings(baseSnapshot, project.file), projectSettings(this.head, project.file))) {
            reasons.push(`${project.file} changed`);
        }
        if (!isNodeRuntime(project)) {
            this.warnings.push(`${project.name}: runtime "${project.runtime}" isn't analysed; any change in ${project.dir || 'the repo'} selects it (list other folders it reads under inputs)`);
            return [
                ...reasons,
                ...this.folderChanges(project, changed, 'not a Node.js project', [
                    ...yamlFileReferences(this.head, project),
                    ...moduleRoots(this.head, project),
                ]),
            ];
        }
        const baseProject = readProject(baseSnapshot, project.file);
        const before = this.analysis(baseSnapshot, baseProject);
        const after = this.analysis(this.head, project);
        reasons.push(...describeFactChanges(before, after));
        const packages = this.packageChanges(project, baseSnapshot, before, after);
        reasons.push(...packages.reasons);
        const gaps = new Map();
        for (const gap of [...after.gaps, ...before.gaps, ...packages.gaps]) {
            gaps.set(`${gap.dir}\0${gap.message}`, gap);
        }
        if (gaps.size > 0) {
            for (const gap of gaps.values())
                this.warnings.push(`${project.name}: ${gap.message}`);
            const first = [...gaps.values()][0];
            reasons.push(...this.folderChanges(project, changed, first.message, [...gaps.values()].map((gap) => gap.dir)));
        }
        return reasons;
    }
    /**
     * The fallback when analysis can't be complete: any change in the project's folder, or in the
     * folders where what analysis couldn't see most likely lives
     */
    folderChanges(project, changed, why, extraDirs = []) {
        const dirs = [project.dir, ...extraDirs];
        const files = [...changed.keys()].filter((path) => dirs.some((dir) => isInside(path, dir)) &&
            !matchesAnyGlob(IGNORED_FILES, path) &&
            !/(^|\/)Pulumi\.[^/]+\.ya?ml$/.test(path) &&
            !path.split('/').includes('node_modules'));
        return files.map((file) => `${file} changed (${why}, so any change in that folder counts)`);
    }
    /**
     * Packages whose resolved identity (version, source, integrity, patch) differs between base and
     * head, among those the program loads and everything they depend on
     */
    packageChanges(project, baseSnapshot, before, after) {
        const gaps = [];
        const resolve = (snapshot, analysis) => {
            const path = findLockfile(snapshot, analysis.programDir, this.warnings);
            const graph = path ? this.lockfile(snapshot, path) : undefined;
            const result = new Map();
            if (!graph)
                return { result, path, graph };
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
                if (!node ||
                    isTypesOnly(node.name) ||
                    matchesAnyGlob(this.config.packages.ignore, node.name))
                    continue;
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
        const reasons = [];
        if (!old.path && !current.path) {
            // No lockfile: dependency ranges in the manifests are all there is to compare
            const manifestPath = findUp(this.head, after.programDir, 'package.json');
            const declared = dependencyRanges(manifestPath ? this.head.read(manifestPath) : undefined);
            const declaredNames = new Set(Object.values(declared).flatMap((field) => field && typeof field === 'object' ? Object.keys(field) : []));
            for (const [name, files] of manifestPath ? after.packages : []) {
                if (declaredNames.has(name) || name === '@pulumi/pulumi')
                    continue;
                const from = [...files][0];
                gaps.push({
                    message: `${from} imports "${name}", which no package.json declares`,
                    dir: dirnameOf(from),
                });
            }
            if (manifestPath) {
                const ranges = (snapshot) => dependencyRanges(snapshot.read(manifestPath));
                if (!isDeepStrictEqual(ranges(baseSnapshot), ranges(this.head))) {
                    reasons.push(`${manifestPath} dependencies changed (there's no lockfile to narrow it down)`);
                }
            }
            return { reasons, gaps };
        }
        if (!old.graph || !current.graph) {
            // An unreadable lockfile can't be narrowed down; any change to it counts
            const changed = old.path !== current.path ||
                (old.path !== undefined && baseSnapshot.hash(old.path) !== this.head.hash(old.path));
            if (changed) {
                reasons.push(`${current.path ?? old.path} changed (couldn't be read package by package)`);
            }
            return { reasons, gaps };
        }
        const names = new Set([...old.result.keys(), ...current.result.keys()]);
        const direct = new Set([...before.packages.keys(), ...after.packages.keys(), '@pulumi/pulumi']);
        const transitive = [];
        for (const name of [...names].sort()) {
            if (!direct.has(name)) {
                const from = [...(old.result.get(name) ?? [])].sort().join('\0');
                const to = [...(current.result.get(name) ?? [])].sort().join('\0');
                if (from !== to)
                    transitive.push(name);
                continue;
            }
            const from = [...(old.result.get(name) ?? [])].sort();
            const to = [...(current.result.get(name) ?? [])].sort();
            if (from.join('\0') === to.join('\0'))
                continue;
            const label = (identities) => identities.map((identity) => identity.split(' ')[0]).join(', ');
            if (from.length === 0)
                reasons.push(`package ${name} ${label(to)} added`);
            else if (to.length === 0)
                reasons.push(`package ${name} ${label(from)} removed`);
            else if (label(from) === label(to))
                reasons.push(`package ${name} ${label(to)} changed source or patch`);
            else
                reasons.push(`package ${name} ${label(from)} → ${label(to)}`);
        }
        // Packages the program imports come first; what they depend on is summed up
        if (transitive.length > 0) {
            const shown = transitive.slice(0, 5).join(', ');
            const more = transitive.length > 5 ? ` and ${transitive.length - 5} more` : '';
            reasons.push(`${transitive.length} packages they depend on changed: ${shown}${more}`);
        }
        return { reasons, gaps };
    }
    /** Why one stack, beyond its project, differs between `base` and head */
    stackReasons(project, stack, base) {
        const baseSnapshot = this.snapshot(base);
        const changed = this.changedFiles(base);
        const reasons = [];
        const before = parseYamlFile(baseSnapshot, stack.configFile);
        const after = parseYamlFile(this.head, stack.configFile);
        if (after && typeof after === 'object' && 'environment' in after) {
            this.warnings.push(`${stack.id} imports ESC environments, which change outside the repository; select it with always, a rule or Pulumi-Affected-Run when they do`);
        }
        if (before === undefined && after !== undefined)
            reasons.push(`${stack.configFile} added`);
        else if (!isDeepStrictEqual(before, withoutNewSalt(before, after))) {
            reasons.push(`${stack.configFile} changed`);
        }
        // Force files: any edit at all, even whitespace, selects the stack
        for (const name of [`Pulumi.${stack.stack}.force`, 'Pulumi.force']) {
            const path = joinPath(project.stackConfigDir, name);
            if (changed.has(path) && this.head.has(path))
                reasons.push(`${path} touched`);
        }
        for (const [pattern, globs] of Object.entries(this.config.inputs)) {
            if (!matchesStack(pattern, stack))
                continue;
            for (const file of changed.keys()) {
                if (matchesAnyGlob(globs, file))
                    reasons.push(`${file} changed (inputs in config)`);
            }
        }
        return reasons;
    }
    /** Edges from stack references in code and from `dependsOn` in the config */
    dependencyGraph(projects, stacks) {
        const graph = new Map();
        for (const project of projects) {
            if (!isNodeRuntime(project)) {
                // Their stack references aren't analysed; a YAML program shows whether it has any
                const text = project.runtime === 'yaml' ? (this.head.read(project.file) ?? '') : undefined;
                if (text === undefined || text.includes('StackReference')) {
                    for (const stack of project.stacks)
                        this.unknownReaders.add(stack.id);
                }
                continue;
            }
            const analysis = this.analysis(this.head, project);
            for (const stack of project.stacks) {
                const stackConfig = parseYamlFile(this.head, stack.configFile);
                const projectConfig = projectConfigValues(this.head, project);
                const readConfig = (namespace, key) => {
                    const values = { ...projectConfig, ...(stackConfig?.config ?? {}) };
                    const value = values[`${namespace}:${key}`] ?? (namespace === project.name ? values[key] : undefined);
                    return typeof value === 'string' ? value : undefined;
                };
                for (const { module, use } of analysis.stackReferences) {
                    const name = evaluateString(use.name, module, {
                        lookup: analysis.lookup,
                        stack: stack.stack,
                        project: project.name,
                        config: readConfig,
                        unknown: WILDCARD,
                    });
                    const targets = stacksNamed(name ?? WILDCARD, project, stacks);
                    if (targets.length === 0)
                        this.unknownReaders.add(stack.id);
                    if (name === undefined || name === WILDCARD) {
                        this.graphWarnings.push(`${stack.id}: a StackReference in ${module.path} has a name that can't be worked out; add it to dependsOn`);
                    }
                    // Output names are worked out like stack names: constants, templates, config
                    // Names this module shows are worked out like stack names (constants, templates,
                    // config); beyond that, the reference is followed through the whole program
                    const local = (() => {
                        if (use.outputs === 'all')
                            return 'all';
                        const names = [];
                        for (const expression of use.outputs) {
                            const output = evaluateString(expression, module, {
                                lookup: analysis.lookup,
                                stack: stack.stack,
                                project: project.name,
                                config: readConfig,
                                unknown: undefined,
                            });
                            if (output === undefined)
                                return 'all';
                            names.push(output);
                        }
                        return names;
                    })();
                    const outputs = local !== 'all'
                        ? local
                        : this.programReferences(project, analysis).outputsRead(module.path, use.ordinal, use.total);
                    for (const target of targets) {
                        addEdge(graph, stack.id, target.id);
                        this.recordReads(stack.id, target.id, outputs);
                    }
                }
            }
        }
        for (const [pattern, dependencies] of Object.entries(this.config.dependsOn)) {
            for (const stack of stacks) {
                if (!matchesStack(pattern, stack))
                    continue;
                for (const dependency of stacks) {
                    if (!matchesAnyStack(dependencies, dependency))
                        continue;
                    addEdge(graph, stack.id, dependency.id);
                    // What a stack reads from a dependency the analysis can't see is unknown
                    this.recordReads(stack.id, dependency.id, 'all');
                    this.unknownReaders.delete(stack.id);
                }
            }
        }
        return graph;
    }
}
/**
 * Matches a referenced stack name to stacks in this repo, the way Pulumi parses it:
 * "org/project/stack", or "org/stack" and "stack" in the referencing project. Unknown parts are
 * "*".
 */
function stacksNamed(name, project, stacks) {
    if (name === WILDCARD)
        return [];
    const parts = name.split('/');
    const stackPart = parts[parts.length - 1];
    const projectPart = parts.length >= 3 ? parts[parts.length - 2] : project.name;
    return stacks.filter((stack) => glob(projectPart)(stack.project) && glob(stackPart)(stack.stack));
}
/**
 * Type declaration packages (@types/*) hold no code that runs, even when a runtime dependency
 * lists one, as protobufjs does @types/node
 */
function isTypesOnly(name) {
    return name.startsWith('@types/');
}
/** Projects analysed as JavaScript: Node.js, and Bun, which runs the same programs */
function isNodeRuntime(project) {
    return project.runtime === 'nodejs' || project.runtime === 'bun';
}
/** Config values and defaults declared in Pulumi.yaml, which stack config files override */
function projectConfigValues(snapshot, project) {
    const settings = parseYamlFile(snapshot, project.file);
    const values = {};
    for (const [key, declared] of Object.entries(settings?.config ?? {})) {
        if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
            const entry = declared;
            if ('value' in entry)
                values[key] = entry.value;
            else if ('default' in entry)
                values[key] = entry.default;
        }
        else {
            values[key] = declared;
        }
    }
    return values;
}
/** Pulumi.yaml settings that affect the program; a new description doesn't */
function projectSettings(snapshot, path) {
    const settings = parseYamlFile(snapshot, path);
    if (settings && typeof settings === 'object') {
        const { description: _description, ...rest } = settings;
        return rest;
    }
    return settings;
}
/**
 * Pulumi writes an encryption salt into a stack's config file when it creates the stack. A salt
 * that wasn't there before can't change what the program does, so it doesn't count; a changed
 * salt does.
 */
function withoutNewSalt(before, after) {
    const isObject = (value) => typeof value === 'object' && value !== null;
    if (!isObject(before) || !isObject(after))
        return after;
    if ('encryptionsalt' in before || !('encryptionsalt' in after))
        return after;
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
function parseYamlFile(snapshot, path) {
    const text = snapshot.read(path);
    if (text === undefined)
        return undefined;
    try {
        return parseYaml(text, { schema: 'failsafe' }) ?? {};
    }
    catch {
        return text;
    }
}
/**
 * Folders a Pulumi YAML program reads files from (fn::readFile, fn::fileAsset, fn::fileArchive),
 * which may be outside the project folder
 */
function yamlFileReferences(snapshot, project) {
    if (project.runtime !== 'yaml')
        return [];
    const text = snapshot.read(project.file) ?? '';
    const dirs = [];
    for (const match of text.matchAll(/fn::(?:readFile|fileAsset|fileArchive)\s*:\s*["']?([^\s"'#]+)/g)) {
        const path = joinPath(project.dir, match[1]);
        dirs.push(snapshot.isDirectory(path) ? path : dirnameOf(path));
    }
    return dirs;
}
/**
 * Where a Go or Python program's module lives: the folder of the nearest go.mod, pyproject.toml,
 * requirements.txt or lockfile, which can be above the project and hold code it imports
 */
function moduleRoots(snapshot, project) {
    const markers = {
        go: ['go.mod'],
        python: ['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock'],
    };
    const roots = [];
    for (const marker of markers[project.runtime] ?? []) {
        const found = findUp(snapshot, project.dir, marker);
        if (found)
            roots.push(dirnameOf(found));
    }
    return roots;
}
/** Patch files (patch-package's patches/<name>+<version>.patch) by the package they patch */
function patchFiles(snapshot, root) {
    const patches = new Map();
    const dir = joinPath(root, 'patches');
    for (const path of snapshot.paths) {
        if (dirnameOf(path) !== dir || !path.endsWith('.patch'))
            continue;
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
function dependencyRanges(text) {
    const manifest = parseJson(text) ?? {};
    const ranges = {};
    for (const field of [
        'dependencies',
        'devDependencies',
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
export function describeFactChanges(before, after) {
    const keys = new Set([...before.facts.keys(), ...after.facts.keys()]);
    const reasons = [];
    const changedModules = new Set();
    for (const key of [...keys].sort()) {
        const old = before.facts.get(key);
        const current = after.facts.get(key);
        if (old === current)
            continue;
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
            const how = old === undefined
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
        }
        else if (kind === 'order') {
            if (!changedModules.has(subject) && old !== undefined && current !== undefined) {
                reasons.push(`${subject}: top-level statements reordered`);
            }
        }
        else if (kind === 'asset') {
            reasons.push(`file ${subject} ${old === undefined ? 'now read' : current === undefined ? 'no longer read' : 'changed'}`);
        }
        else if (kind === 'compilerOptions') {
            reasons.push('TypeScript compiler options that affect the output changed');
        }
        else if (kind === 'entry') {
            reasons.push(`entry file changed from ${old} to ${current}`);
        }
        else if (kind === 'manifest') {
            reasons.push(`${subject}: type, main, imports or exports changed`);
        }
        else if (kind === 'imports') {
            reasons.push(`${subject}: what its imports refer to changed`);
        }
        else if (kind === 'export') {
            const hash = subject.lastIndexOf('#');
            reasons.push(`${subject.slice(0, hash)}: export \`${subject.slice(hash + 1)}\` ${old === undefined ? 'added' : current === undefined ? 'removed' : 'changed'}`);
        }
    }
    return reasons;
}
/**
 * Pulumi-Affected-Run/Skip/Create-Stacks lines in commit messages between base and head, and in
 * `messages`
 */
function readRequests(repoRoot, base, options) {
    const run = [];
    const skip = [];
    const create = [];
    const scan = (text, source) => {
        for (const line of text.split('\n')) {
            const creation = /^\s*Pulumi-Affected-Create-Stacks\s*:\s*(plan|apply)\b(.*)$/i.exec(line);
            if (creation) {
                const mode = creation[1].toLowerCase();
                create.push({ mode, patterns: splitPatterns(creation[2]), source });
                continue;
            }
            const match = /^\s*(Pulumi-Affected-(?:Run|Skip))\s*:\s*(.+)$/i.exec(line);
            if (!match)
                continue;
            const list = match[1].toLowerCase() === RUN_TRAILER.toLowerCase() ? run : skip;
            for (const pattern of splitPatterns(match[2]))
                list.push({ pattern, source });
        }
    };
    const headRev = options.head ?? 'HEAD';
    const log = git(repoRoot, ['log', '--format=%h%x00%B%x01', `${base}..${headRev}`]);
    for (const entry of log.split('\u0001')) {
        const [sha, body] = entry.trim().split('\u0000');
        if (body)
            scan(body, `commit ${sha}`);
    }
    for (const message of options.messages ?? [])
        scan(message, 'the pull request');
    if (options.all)
        run.push({ pattern: 'all', source: '--all' });
    for (const pattern of options.run ?? [])
        run.push({ pattern, source: '--run' });
    for (const pattern of options.skip ?? [])
        skip.push({ pattern, source: '--skip' });
    return { run, skip, create };
}
/** The stacks in the repo and how they depend on each other, as of `head` */
export function readDependencyGraph(options) {
    const repoRoot = repoRootOf(options.cwd);
    const head = options.head
        ? new GitSnapshot(repoRoot, resolveCommit(repoRoot, options.head))
        : new WorktreeSnapshot(repoRoot);
    const config = options.config ?? loadConfig(head);
    const session = new Session(repoRoot, head, config);
    const projects = discoverProjects(head, config);
    const stacks = projects.flatMap((project) => project.stacks);
    const graph = session.dependencyGraph(projects, stacks);
    return {
        stacks,
        graph,
        outputsRead: session.outputsReadRecord(),
        unknownReaders: [...session.unknownReaders].sort(),
        warnings: session.graphWarnings,
    };
}
