import ts from 'typescript';
import type { Project } from '../projects.ts';
import { dirnameOf, isInside, joinPath, type Snapshot } from '../snapshot.ts';
import { anchorOf, type EvaluationContext, evaluateString } from './evaluate.ts';
import { type Item, type ModuleInfo, type PathCandidate, parseModule } from './module.ts';
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
   * Where analysis may have missed inputs (a computed `require`, an unresolvable import, a file
   * read whose path can't be worked out). Selection then also counts any change in the project
   * folder and in each gap's folder.
   */
  gaps: Gap[];
  entry: string | undefined;
  /** The folder Pulumi runs the program in: `main` when it's a folder, else the project's */
  programDir: string;
  /** Finds constants in this snapshot's modules, for evaluating stack reference names */
  lookup: EvaluationContext['lookup'];
}

export interface Gap {
  message: string;
  /** The folder where whatever analysis couldn't see most likely lives */
  dir: string;
}

/** Modules whose functions all take a path first */
const FILE_SYSTEM_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'fs-extra',
  'glob',
  'fast-glob',
  'globby',
  'tinyglobby',
]);

const GLOB_CHARACTERS = /[*?[{]/;

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
  // These decide whether modules get "use strict"
  'strict',
  'alwaysStrict',
  'noImplicitUseStrict',
] as const;

export function analyzeProject(
  snapshot: Snapshot,
  project: Project,
  cache: ModuleCache,
): ProjectAnalysis {
  const programDir = programDirOf(snapshot, project);
  const runtimeTsconfig = stringOption(project, 'tsconfig');
  const resolver = new Resolver(
    snapshot,
    programDir,
    joinPath(programDir, runtimeTsconfig ?? 'tsconfig.json'),
  );
  const analysis: ProjectAnalysis = {
    facts: new Map(),
    chains: new Map(),
    packages: new Map(),
    stackReferences: [],
    gaps: [],
    entry: findEntry(snapshot, project, programDir, resolver),
    programDir,
    lookup: () => undefined,
  };
  const addGap = (message: string, dir: string) => analysis.gaps.push({ message, dir });
  for (const extendsPackage of resolver.configPackages) {
    addPackageReference(extendsPackage, resolver.tsconfig ?? project.file);
  }
  const facts = analysis.facts;
  const optionsKey = JSON.stringify(pick(resolver.options, EMIT_OPTIONS));
  facts.set('compilerOptions', optionsKey);
  facts.set('entry', analysis.entry ?? '(none)');
  recordManifestFact(snapshot, programDir, facts);

  if (!analysis.entry) {
    addGap('no entry file found', programDir);
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

  const addPackage = addPackageReference;

  /** Resolves a specifier; returns the module file, or undefined for packages and builtins */
  const follow = (specifier: string, from: string) => {
    const resolution = resolver.resolve(specifier, from);
    if (resolution.kind === 'file') return resolution.path;
    if (resolution.kind === 'package') addPackage(resolution.name, from);
    if (resolution.kind === 'unresolved') {
      addGap(`${from}: can't resolve "${specifier}"`, resolution.dir ?? dirnameOf(from));
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
      addGap(`${path} is imported but missing`, dirnameOf(path));
      return;
    }
    for (const specifier of module.loads) {
      const target = follow(specifier, path);
      if (target) markLoaded(target, path);
    }
    for (const item of module.items) if (item.eager) markItem(module, item);
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
    for (const sibling of item.siblings) markItem(module, sibling);
    for (const reason of item.unanalysable)
      addGap(`${module.path}: ${reason}`, dirnameOf(module.path));
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
      // Which binding a name refers to is a fact: `import { dev as config }` → `{ prod as config }`
      // changes nothing else
      recordBinding(module.path, `${name}=${binding.specifier}:${binding.imported}`);
      markImport(module.path, binding.specifier, imported);
    }
    for (const asset of item.assets) recordPath(module, asset, 'read');
    for (const call of item.calls) {
      if (readsThroughFileSystemModule(module, call)) recordPath(module, call.argument, 'read');
    }
    for (const candidate of item.pathCandidates) recordCandidate(module, candidate);
    for (const expression of item.resolved) recordResolved(module, expression);
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
    // What a name exports is a fact: `export { a as first }` → `export { b as first }`, or
    // `export` added to a constant (a new stack output)
    facts.set(`export:${path}#${name}`, target ? JSON.stringify(target) : '(through export *)');
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

  /**
   * Records a path the program uses. A `read` must be worked out, or it's a gap; a `candidate`
   * (a path-like value) counts only if it names something in the repository.
   */
  const recordPath = (module: ModuleInfo, expression: ts.Expression, kind: 'read') => {
    const value = evaluateString(expression, module, { lookup, unknown: undefined });
    if (value === undefined) {
      addGap(
        `${module.path}: a file is read from a path that can't be worked out`,
        dirnameOf(module.path),
      );
      return;
    }
    const candidates = pathCandidates(withoutGlob(value), module.path, kind);
    if (candidates === undefined) {
      addGap(`${module.path}: reads absolute path ${anchorOf(value).rest}`, dirnameOf(module.path));
      return;
    }
    for (const candidate of candidates) {
      if (candidate === '') {
        // The whole repository: any change counts
        addGap(`${module.path}: reads the whole repository`, '');
        return;
      }
      if (recordExisting(candidate)) return;
    }
    // Missing in this snapshot: perhaps build output that isn't committed, built from sources
    // near it, or a file the other snapshot has
    facts.set(`asset:${candidates[0]}`, '(missing)');
    addGap(
      `${module.path}: reads ${candidates[0]}, which isn't in the repository (build output?)`,
      existingAncestor(candidates[0]),
    );
  };

  /**
   * A path-like value counts when it names something in the repository. Bare "./" or "../", the
   * program's own source, or a folder holding the project count only as a Docker build context,
   * where they really are the input; otherwise they'd make every change count.
   */
  const recordCandidate = (module: ModuleInfo, candidate: PathCandidate) => {
    const isContext = candidate.property === 'context' || candidate.property === 'dockerfile';
    const value = evaluateString(candidate.expression, module, { lookup, unknown: undefined });
    if (value === undefined) {
      if (isContext) {
        addGap(
          `${module.path}: a Docker build ${candidate.property} that can't be worked out`,
          dirnameOf(module.path),
        );
      }
      return;
    }
    if (!isContext && /^(\.\.?\/?)+$/.test(anchorOf(value).rest)) return;
    for (const path of pathCandidates(withoutGlob(value), module.path, 'candidate') ?? []) {
      const holdsProject = isInside(project.dir, path) || isInside(programDir, path);
      if (!isContext && (holdsProject || modules.has(path))) continue;
      if (path === '') {
        addGap(`${module.path}: a Docker build context of the whole repository`, '');
        return;
      }
      if (recordExisting(path)) return;
    }
  };

  /** A glob reads everything under its fixed part */
  const withoutGlob = (value: string) => {
    const globAt = value.search(GLOB_CHARACTERS);
    return globAt === -1 ? value : value.slice(0, value.lastIndexOf('/', globAt) + 1);
  };

  const pathCandidates = (value: string, modulePath: string, kind: 'read' | 'candidate') => {
    const { anchor, rest, ...anchored } = anchorOf(value) as ReturnType<typeof anchorOf> & {
      dir?: string;
    };
    if (anchor === 'module') return [joinPath(anchored.dir ?? '', rest)];
    if (anchor === 'cwd') return [joinPath(programDir, rest)];
    if (rest.startsWith('/')) return undefined;
    const list = [joinPath(programDir, rest), joinPath(project.dir, rest)];
    // A path-like value may also be relative to the module that holds it
    if (kind === 'candidate') list.push(joinPath(dirnameOf(modulePath), rest));
    return [...new Set(list)];
  };

  const bindings = new Map<string, Set<string>>();
  const recordBinding = (path: string, binding: string) => {
    const set = bindings.get(path) ?? new Set();
    set.add(binding);
    bindings.set(path, set);
  };

  const recordExisting = (candidate: string) => {
    if (snapshot.isDirectory(candidate)) {
      // Through any links, so a linked folder's files count
      const real = snapshot.realPath(candidate) ?? candidate;
      for (const file of snapshot.paths) {
        if (isInside(file, real)) facts.set(`asset:${file}`, snapshot.hash(file) ?? '');
      }
      return true;
    }
    if (snapshot.has(candidate)) {
      facts.set(`asset:${candidate}`, snapshot.hash(candidate) ?? '');
      return true;
    }
    return false;
  };

  const existingAncestor = (path: string) => {
    let current = dirnameOf(path);
    while (current !== '' && !snapshot.isDirectory(current)) current = dirnameOf(current);
    return current;
  };

  /** require.resolve("./file") is a file next to the module; require.resolve("pkg") a package */
  const recordResolved = (module: ModuleInfo, expression: ts.Expression) => {
    const value = evaluateString(expression, module, { lookup, unknown: undefined });
    const anchored = value === undefined ? undefined : anchorOf(value);
    if (value === undefined || anchored === undefined) {
      addGap(`${module.path}: require.resolve() with a computed path`, dirnameOf(module.path));
    } else if (anchored.anchor === 'module' || value.startsWith('.')) {
      const dir = anchored.anchor === 'module' ? anchored.dir : dirnameOf(module.path);
      const path = joinPath(dir, anchored.rest);
      if (!recordExisting(path)) {
        addGap(
          `${module.path}: resolves ${path}, which isn't in the repository`,
          existingAncestor(path),
        );
      }
    } else if (!value.startsWith('/')) {
      follow(value, module.path);
    }
  };

  /** fs.readFileSync(p), readFile(p) imported from fs, glob(p), fse.readJson(p), … */
  const readsThroughFileSystemModule = (
    module: ModuleInfo,
    call: { object?: string; name: string },
  ) => {
    const binding = module.imports.get(call.object ?? call.name);
    return binding !== undefined && FILE_SYSTEM_MODULES.has(binding.specifier);
  };

  markLoaded(analysis.entry, undefined);
  // A program's exports are its stack outputs, so they matter even if nothing uses them
  markExport(analysis.entry, '*');
  for (const preload of nodeargsFiles(project)) {
    // Node loads these before the program: `-r ./setup.js`, `--import ./register.mjs`
    if (preload.kind === 'env-file') {
      if (!recordExisting(joinPath(programDir, preload.path))) {
        addGap(`nodeargs reads ${preload.path}, which isn't in the repository`, programDir);
      }
    } else if (/^\.\.?\//.test(preload.path)) {
      const file = resolver.findSource(joinPath(programDir, preload.path));
      if (file) markLoaded(file, undefined);
      else addGap(`nodeargs loads ${preload.path}, which can't be found`, programDir);
    } else {
      addPackage(packageNameOf(preload.path), project.file);
    }
  }
  // dotenv reads .env from the working directory
  if (analysis.packages.has('dotenv')) recordExisting(joinPath(programDir, '.env'));

  // Statement order matters: imports run in order, and a `var` used before its assignment is
  // undefined. Only loads and reachable statements count, so moving unused code changes nothing.
  // Only loads that run code count: a local module with eager statements somewhere below it.
  // Package imports are left out, so sorting imports changes nothing. Function declarations are
  // hoisted, so where they sit doesn't count either.
  const runsCode = new Map<string, boolean>();
  const hasEagerCode = (path: string, seen = new Set<string>()): boolean => {
    const known = runsCode.get(path);
    if (known !== undefined) return known;
    if (seen.has(path)) return false;
    seen.add(path);
    const module = modules.get(path);
    const result =
      module === undefined ||
      module.items.some((item) => item.eager) ||
      module.loads.some((specifier) => {
        const resolution = resolver.resolve(specifier, path);
        return resolution.kind === 'file' && hasEagerCode(resolution.path, seen);
      });
    runsCode.set(path, result);
    return result;
  };
  for (const path of loaded) {
    const module = modules.get(path);
    if (!module) continue;
    const reachableKeys = new Set(
      module.items.filter((item) => reachable.has(item) && !item.hoisted).map((item) => item.key),
    );
    const order = module.order.filter((entry) => {
      if (!entry.startsWith('load ')) return reachableKeys.has(entry);
      const resolution = resolver.resolve(entry.slice('load '.length), path);
      return resolution.kind === 'file' && hasEagerCode(resolution.path);
    });
    facts.set(`order:${path}`, order.join(' '));
    const used = bindings.get(path);
    if (used) facts.set(`imports:${path}`, [...used].sort().join(' '));
  }
  return analysis;

  function addPackageReference(name: string, from: string) {
    const files = analysis.packages.get(name) ?? new Set();
    files.add(from);
    analysis.packages.set(name, files);
  }
}

function stringOption(project: Project, name: string) {
  const value = project.runtimeOptions[name];
  return typeof value === 'string' ? value : undefined;
}

/** Files and packages named by `runtime.options.nodeargs` */
function nodeargsFiles(project: Project) {
  const nodeargs = stringOption(project, 'nodeargs') ?? '';
  const tokens = nodeargs.split(/\s+/).filter(Boolean);
  const files: { kind: 'module' | 'env-file'; path: string }[] = [];
  const modules = ['--require', '-r', '--import', '--loader', '--experimental-loader'];
  for (let index = 0; index < tokens.length; index++) {
    const [flag, inline] = tokens[index].split(/=(.*)/s);
    const value = inline ?? tokens[index + 1];
    if (modules.includes(flag) && value) {
      files.push({ kind: 'module', path: value });
      if (inline === undefined) index++;
    } else if (flag === '--env-file' && value) {
      files.push({ kind: 'env-file', path: value });
      if (inline === undefined) index++;
    }
  }
  return files;
}

function packageNameOf(specifier: string) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
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
 * The folder Pulumi runs the program in: `main`'s folder when `main` names a file (even build
 * output that isn't committed), `main` itself when it's a folder, else the project folder
 */
export function programDirOf(snapshot: Snapshot, project: Project) {
  if (!project.main) return project.dir;
  const main = joinPath(project.dir, project.main);
  const isFile =
    snapshot.has(main) || (/\.[cm]?[jt]sx?$/.test(main) && !snapshot.isDirectory(main));
  return isFile ? dirnameOf(main) : main;
}

/**
 * What Pulumi runs, as its Node.js language host decides: `main` from Pulumi.yaml when it's a
 * file; otherwise, from the nearest package.json at or above the program folder, its `exports`
 * (a string, or "." as default, require or import) or else its `main`, each only if that file
 * exists; otherwise the program folder's index. Build output that isn't committed is mapped
 * back to its source through the tsconfig's outDir and rootDir.
 */
function findEntry(snapshot: Snapshot, project: Project, programDir: string, resolver: Resolver) {
  if (project.main) {
    const main = joinPath(project.dir, project.main);
    if (snapshot.has(main)) return main;
    if (dirnameOf(main) === programDir && !snapshot.isDirectory(main)) {
      return resolver.sourceForOutput(main) ?? resolver.findSource(main);
    }
  }
  const manifestPath = findUp(snapshot, programDir, 'package.json');
  const manifest = manifestPath ? parseJson(snapshot.read(manifestPath)) : undefined;
  if (manifestPath && manifest) {
    const root = dirnameOf(manifestPath);
    for (const candidate of entryCandidates(manifest)) {
      const path = joinPath(root, candidate);
      if (snapshot.has(path)) return path;
      const source = resolver.sourceForOutput(path);
      if (source) return source;
    }
  }
  return resolver.findSource(joinPath(programDir, 'index'));
}

function entryCandidates(manifest: Record<string, unknown>) {
  const candidates: string[] = [];
  const exports = manifest.exports;
  if (typeof exports === 'string') {
    candidates.push(exports);
  } else if (exports && typeof exports === 'object' && '.' in exports) {
    const root = (exports as Record<string, unknown>)['.'];
    if (typeof root === 'string') candidates.push(root);
    else if (root && typeof root === 'object') {
      for (const condition of ['default', 'require', 'import']) {
        const value = (root as Record<string, unknown>)[condition];
        if (typeof value === 'string') {
          candidates.push(value);
          break;
        }
      }
    }
  }
  if (typeof manifest.main === 'string') candidates.push(manifest.main);
  return candidates;
}

/** Fields of the project's package.json that change how its code runs */
function recordManifestFact(snapshot: Snapshot, programDir: string, facts: Map<string, string>) {
  const path = findUp(snapshot, programDir, 'package.json');
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
