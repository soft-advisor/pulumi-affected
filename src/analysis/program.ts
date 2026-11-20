import ts from 'typescript';
import type { Project } from '../projects.ts';
import { dirnameOf, isInside, joinPath, type Snapshot } from '../snapshot.ts';
import { type EvaluationContext, evaluateString, MODULE_DIR, WORKING_DIR } from './evaluate.ts';
import { type Item, type ModuleInfo, parseModule } from './module.ts';
import { findUp, parseJson, Resolver } from './resolve.ts';

/*
 * Analyses one project's program in one snapshot: starting from the entry file, it follows what
 * actually runs (every eager item of every loaded module, and the lazy items those reference,
 * transitively) and records each piece as a "fact". Comparing the base and head facts tells
 * whether the program changed, and which piece did.
 */

export interface ProjectAnalysis {
  /** Fact key → value; a project changed when any fact differs between base and head */
  facts: Map<string, string>;
  /** Module path → the import chain from the entry file that loads it */
  chains: Map<string, string[]>;
  /** npm package name → files that load it */
  packages: Map<string, Set<string>>;
  stackReferences: { module: ModuleInfo; expression: ts.Expression }[];
  /**
   * Why analysis may have missed inputs (a computed `require`, an unresolvable import, a file
   * read whose path can't be worked out). Selection then falls back to watching every file in
   * the project folder.
   */
  gaps: string[];
  entry: string | undefined;
  /** Finds constants in this snapshot's modules, for evaluating stack reference names */
  lookup: EvaluationContext['lookup'];
}

/** Parsed modules shared across projects and snapshots, keyed by content and compiler options */
export type ModuleCache = Map<string, ModuleInfo>;

/** Compiler options that change the JavaScript a program runs */
const EMIT_OPTIONS = [
  'target',
  'module',
  'moduleResolution',
  'baseUrl',
  'paths',
  'rootDirs',
  'esModuleInterop',
  'allowSyntheticDefaultImports',
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'useDefineForClassFields',
  'verbatimModuleSyntax',
  'preserveValueImports',
  'importsNotUsedAsValues',
  'isolatedModules',
  'importHelpers',
  'downlevelIteration',
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'jsxImportSource',
  'allowJs',
  'resolveJsonModule',
  'moduleSuffixes',
  'customConditions',
] as const;

export function analyzeProject(
  snapshot: Snapshot,
  project: Project,
  cache: ModuleCache,
): ProjectAnalysis {
  const resolver = new Resolver(snapshot, project.dir);
  const analysis: ProjectAnalysis = {
    facts: new Map(),
    chains: new Map(),
    packages: new Map(),
    stackReferences: [],
    gaps: [],
    entry: findEntry(snapshot, project, resolver),
    lookup: () => undefined,
  };
  const facts = analysis.facts;
  const optionsKey = JSON.stringify(pick(resolver.options, EMIT_OPTIONS));
  facts.set('compilerOptions', optionsKey);
  facts.set('entry', analysis.entry ?? '(none)');
  recordManifestFact(snapshot, project, facts);

  if (!analysis.entry) {
    analysis.gaps.push('no entry file found');
    return analysis;
  }

  const modules = new Map<string, ModuleInfo | undefined>();
  const loaded = new Set<string>();
  const reachable = new Set<Item>();
  const exportsMarked = new Set<string>();

  const getModule = (path: string) => {
    if (modules.has(path)) return modules.get(path);
    const text = snapshot.read(path);
    let module: ModuleInfo | undefined;
    if (text !== undefined) {
      const key = `${snapshot.hash(path)}\0${path}\0${optionsKey}`;
      module = cache.get(key);
      if (!module) {
        module = parseModule(path, text, resolver.options);
        cache.set(key, module);
      }
    }
    modules.set(path, module);
    return module;
  };

  const addPackage = (name: string, from: string) => {
    const files = analysis.packages.get(name) ?? new Set();
    files.add(from);
    analysis.packages.set(name, files);
  };

  /** Resolves a specifier; returns the module file, or undefined for packages and builtins */
  const follow = (specifier: string, from: string) => {
    const resolution = resolver.resolve(specifier, from);
    if (resolution.kind === 'file') return resolution.path;
    if (resolution.kind === 'package') addPackage(resolution.name, from);
    if (resolution.kind === 'unresolved') {
      analysis.gaps.push(`${from}: can't resolve "${specifier}"`);
    }
    return undefined;
  };

  const markLoaded = (path: string, from: string | undefined) => {
    if (loaded.has(path)) return;
    loaded.add(path);
    const parentChain = from ? (analysis.chains.get(from) ?? [from]) : [];
    analysis.chains.set(path, [...parentChain, path]);
    const module = getModule(path);
    if (!module) {
      analysis.gaps.push(`${path} is imported but missing`);
      return;
    }
    for (const specifier of module.loads) {
      const target = follow(specifier, path);
      if (target) markLoaded(target, path);
    }
    for (const item of module.items) if (item.eager) markItem(module, item);
    facts.set(
      `order:${path}`,
      module.items
        .filter((item) => item.eager)
        .map((item) => item.key)
        .join(' '),
    );
  };

  const markWhole = (path: string, from: string) => {
    markLoaded(path, from);
    const module = getModule(path);
    for (const item of module?.items ?? []) markItem(module as ModuleInfo, item);
  };

  const markItem = (module: ModuleInfo, item: Item) => {
    if (reachable.has(item)) return;
    reachable.add(item);
    facts.set(`code:${module.path}#${item.key}`, item.code);
    for (const reason of item.unanalysable) analysis.gaps.push(`${module.path}: ${reason}`);
    for (const ref of item.refs) {
      if (ref.kind === 'module') {
        const target = follow(ref.specifier, module.path);
        if (target) markWhole(target, module.path);
        continue;
      }
      const name = ref.kind === 'name' ? ref.name : ref.object;
      const local = module.itemsByName.get(name);
      if (local) {
        markItem(module, local);
        continue;
      }
      const binding = module.imports.get(name);
      if (!binding) continue; // a global, or a local variable of the item itself
      const imported =
        binding.imported === '*' && ref.kind === 'member' ? ref.property : binding.imported;
      markImport(module.path, binding.specifier, imported);
    }
    for (const asset of item.assets) recordAsset(module, asset);
    for (const expression of item.stackReferences) {
      analysis.stackReferences.push({ module, expression });
    }
  };

  const markImport = (from: string, specifier: string, name: string) => {
    const target = follow(specifier, from);
    if (!target) return;
    markLoaded(target, from);
    markExport(target, name);
  };

  const markExport = (path: string, name: string) => {
    const key = `${path}\0${name}`;
    if (exportsMarked.has(key)) return;
    exportsMarked.add(key);
    const module = getModule(path);
    if (!module) return;
    if (module.opaque) {
      markWhole(path, path);
      return;
    }
    if (name === '*') {
      for (const exportName of module.exports.keys()) markExport(path, exportName);
      for (const specifier of module.starExports) {
        const target = follow(specifier, path);
        if (target) markExport(target, '*');
      }
      return;
    }
    const target = module.exports.get(name);
    if (target?.kind === 'reexport') {
      markImport(path, target.specifier, target.imported);
      return;
    }
    if (target?.kind === 'local') {
      const item = module.itemsByName.get(target.local);
      if (item) {
        markItem(module, item);
        return;
      }
      const binding = module.imports.get(target.local);
      if (binding) markImport(path, binding.specifier, binding.imported);
      return;
    }
    // Not declared here: it can only come through `export * from`
    for (const specifier of module.starExports) {
      const starTarget = follow(specifier, path);
      if (starTarget) markExport(starTarget, name);
    }
  };

  const lookup: EvaluationContext['lookup'] = (module, name) =>
    lookupConstant(module, name, getModule, (specifier, from) => {
      const resolution = resolver.resolve(specifier, from);
      return resolution.kind === 'file' ? resolution.path : undefined;
    });
  analysis.lookup = lookup;

  const recordAsset = (module: ModuleInfo, expression: ts.Expression) => {
    const value = evaluateString(expression, module, { lookup, unknown: undefined });
    if (value === undefined) {
      analysis.gaps.push(`${module.path}: a file is read from a path that can't be worked out`);
      return;
    }
    const programDir = dirnameOf(analysis.entry as string);
    const candidates = value.startsWith(MODULE_DIR)
      ? [joinPath(dirnameOf(module.path), value.slice(MODULE_DIR.length))]
      : value.startsWith(WORKING_DIR)
        ? [joinPath(project.dir, value.slice(WORKING_DIR.length))]
        : value.startsWith('/')
          ? []
          : [joinPath(project.dir, value), joinPath(programDir, value)];
    if (candidates.length === 0) {
      analysis.gaps.push(`${module.path}: reads absolute path ${value}`);
      return;
    }
    for (const candidate of candidates) {
      if (snapshot.isDirectory(candidate)) {
        for (const file of snapshot.paths) {
          if (isInside(file, candidate)) facts.set(`asset:${file}`, snapshot.hash(file) ?? '');
        }
        return;
      }
      if (snapshot.has(candidate)) {
        facts.set(`asset:${candidate}`, snapshot.hash(candidate) ?? '');
        return;
      }
    }
    // Missing in this snapshot; it may exist in the other one
    facts.set(`asset:${candidates[0]}`, '(missing)');
  };

  markLoaded(analysis.entry, undefined);
  // A program's exports are its stack outputs, so they matter even if nothing uses them
  markExport(analysis.entry, '*');
  return analysis;
}

/** Finds the initializer of a top-level constant, following imports to where it's declared */
function lookupConstant(
  module: ModuleInfo,
  name: string,
  getModule: (path: string) => ModuleInfo | undefined,
  resolve: (specifier: string, from: string) => string | undefined,
  depth = 0,
): { module: ModuleInfo; node: ts.Expression } | undefined {
  if (depth > 10) return undefined;
  for (const statement of module.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ? { module, node: declaration.initializer } : undefined;
      }
    }
  }
  const binding = module.imports.get(name);
  if (!binding || binding.imported === '*') return undefined;
  const path = resolve(binding.specifier, module.path);
  const target = path ? getModule(path) : undefined;
  if (!target) return undefined;
  const exported = target.exports.get(binding.imported);
  if (exported?.kind === 'local') {
    return lookupConstant(target, exported.local, getModule, resolve, depth + 1);
  }
  return undefined;
}

/**
 * Pulumi runs `main` from Pulumi.yaml (a file, or a folder with a package.json or index file),
 * or else the project folder's package.json `main`, or else its index file.
 */
function findEntry(snapshot: Snapshot, project: Project, resolver: Resolver) {
  const programDir = project.main ? joinPath(project.dir, project.main) : project.dir;
  if (project.main && snapshot.has(programDir)) return programDir;
  const manifest = parseJson(snapshot.read(joinPath(programDir, 'package.json')));
  if (typeof manifest?.main === 'string') {
    const main = joinPath(programDir, manifest.main);
    const found =
      resolver.findSource(main) ??
      resolver.findSource(main.replace(/(^|\/)(dist|lib|build|out|bin)\//, '$1'));
    if (found) return found;
  }
  return resolver.findSource(joinPath(programDir, 'index'));
}

/** Fields of the project's package.json that change how its code runs */
function recordManifestFact(snapshot: Snapshot, project: Project, facts: Map<string, string>) {
  const path = findUp(snapshot, project.dir, 'package.json');
  if (!path) return;
  const manifest = parseJson(snapshot.read(path)) ?? {};
  facts.set(
    `manifest:${path}`,
    JSON.stringify(pick(manifest, ['type', 'main', 'imports', 'exports'] as const)),
  );
}

function pick<T extends object, K extends string>(value: T, keys: readonly K[]) {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined) picked[key] = field;
  }
  return picked;
}
