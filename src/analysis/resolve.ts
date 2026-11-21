import { builtinModules } from 'node:module';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { matchesAnyGlob } from '../patterns.ts';
import { dirnameOf, isInside, joinPath, type Snapshot } from '../snapshot.ts';

/*
 * Module resolution runs against a snapshot (a commit or the working tree), not the disk, so the
 * base revision resolves exactly as it was. node_modules isn't committed, so a bare specifier is
 * either a workspace package (resolved to its source) or an npm package (tracked by version
 * through the lockfile). Workspace packages also appear under every node_modules folder, the way
 * package managers link them, so tsconfig `extends` and TypeScript's own resolution find them.
 */

export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'package'; name: string }
  | { kind: 'builtin' }
  /** `dir` is the folder whatever couldn't be resolved most likely lives in */
  | { kind: 'unresolved'; dir?: string };

/** Virtual root the snapshot is mounted at, so TypeScript sees absolute paths */
const ROOT = '/__repo__';

function toAbsolute(path: string) {
  return path === '' ? ROOT : `${ROOT}/${path}`;
}

function toRelative(path: string) {
  if (path === ROOT) return '';
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined;
}

const BUILTINS = new Set(builtinModules);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Conditions Node.js matches in `exports` and `imports` when running a program */
const CONDITIONS = ['node', 'require', 'import', 'default'];

export class Resolver {
  readonly options: ts.CompilerOptions;
  /** The tsconfig.json used, if any */
  readonly tsconfig: string | undefined;
  /** npm packages the tsconfig extends; their versions count like any other package */
  readonly configPackages: string[] = [];
  private readonly host: ts.ModuleResolutionHost;
  private readonly workspacePackages: Map<string, string>;
  private readonly cache = new Map<string, Resolution>();
  private readonly snapshot: Snapshot;

  constructor(snapshot: Snapshot, programDir: string, tsconfigPath?: string) {
    this.snapshot = snapshot;
    this.workspacePackages = workspacePackagesOf(snapshot);
    const real = (path: string) => {
      const relative = toRelative(path);
      return relative === undefined ? undefined : this.throughWorkspaceLinks(relative);
    };
    this.host = {
      fileExists: (path) => {
        const relative = real(path);
        return relative !== undefined && snapshot.has(relative);
      },
      readFile: (path) => {
        const relative = real(path);
        return relative === undefined ? undefined : snapshot.read(relative);
      },
      directoryExists: (path) => {
        const relative = real(path);
        return relative !== undefined && snapshot.isDirectory(relative);
      },
      realpath: (path) => {
        const relative = real(path);
        return relative === undefined ? path : toAbsolute(relative);
      },
      getCurrentDirectory: () => toAbsolute(programDir),
    };
    // Pulumi hands ts-node exactly one tsconfig (runtime.options.tsconfig, else tsconfig.json in
    // the program's folder) and doesn't look further up; without one, ts-node's defaults apply
    this.tsconfig = tsconfigPath && snapshot.has(tsconfigPath) ? tsconfigPath : undefined;
    this.options = this.tsconfig ? this.readCompilerOptions(this.tsconfig) : {};
  }

  /** node_modules/<workspace package>/x → the package's own folder/x */
  private throughWorkspaceLinks(path: string) {
    const marker = path.lastIndexOf('node_modules/');
    if (marker === -1) return path;
    const rest = path.slice(marker + 'node_modules/'.length);
    const name = packageName(rest);
    const dir = this.workspacePackages.get(name);
    return dir === undefined ? path : joinPath(dir, rest.slice(name.length));
  }

  private readCompilerOptions(tsconfig: string): ts.CompilerOptions {
    const text = this.snapshot.read(tsconfig) ?? '{}';
    const json = ts.parseConfigFileTextToJson(tsconfig, text).config ?? {};
    const extendsList = [json.extends ?? []].flat() as string[];
    const realExtends = extendsList.map((extended) => {
      const isBare = !extended.startsWith('.') && !extended.startsWith('/');
      if (!isBare) return extended;
      const name = packageName(extended);
      const dir = this.workspacePackages.get(name);
      if (dir === undefined) {
        this.configPackages.push(name);
        return extended;
      }
      // Point at the package's real folder, so paths in it resolve from there
      return toAbsolute(joinPath(dir, extended.slice(name.length)));
    });
    if (json.extends !== undefined) {
      json.extends = Array.isArray(json.extends) ? realExtends : realExtends[0];
    }
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: this.host.fileExists,
      readFile: this.host.readFile,
    };
    const parsed = ts.parseJsonConfigFileContent(
      json,
      parseHost,
      toAbsolute(dirnameOf(tsconfig)),
      undefined,
      toAbsolute(tsconfig),
    );
    return parsed.options;
  }

  /** Resolves `specifier` as imported from the repo-relative file `from` */
  resolve(specifier: string, from: string): Resolution {
    const key = `${from}\0${specifier}`;
    let resolution = this.cache.get(key);
    if (!resolution) {
      resolution = this.resolveUncached(specifier, from);
      this.cache.set(key, resolution);
    }
    return resolution;
  }

  private resolveUncached(specifier: string, from: string): Resolution {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return { kind: 'builtin' };
    if (specifier.startsWith('#')) return this.resolveSubpathImport(specifier, from);

    const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
    const local = this.resolveWithTypeScript(specifier, from);
    if (local) return { kind: 'file', path: local };
    if (isRelative) {
      // Node also tries .json for a path without an extension; TypeScript doesn't
      const json = joinPath(dirnameOf(from), `${specifier}.json`);
      if (this.snapshot.has(json)) return { kind: 'file', path: json };
      return {
        kind: 'unresolved',
        dir: this.existingAncestor(joinPath(dirnameOf(from), specifier)),
      };
    }

    const name = packageName(specifier);
    const workspaceDir = this.workspacePackages.get(name);
    if (workspaceDir !== undefined) {
      const entry = this.resolveWorkspaceEntry(workspaceDir, specifier.slice(name.length + 1));
      return entry ? { kind: 'file', path: entry } : { kind: 'unresolved', dir: workspaceDir };
    }
    return { kind: 'package', name };
  }

  /** `#alias` specifiers, through the `imports` field of the nearest package.json */
  private resolveSubpathImport(specifier: string, from: string): Resolution {
    let dir = dirnameOf(from);
    while (true) {
      const manifest = parseJson(this.snapshot.read(joinPath(dir, 'package.json')));
      if (manifest) {
        const target = matchSubpath(manifest.imports, specifier);
        if (target === undefined) return { kind: 'unresolved', dir };
        if (!target.startsWith('.')) return this.resolve(target, from);
        const path = joinPath(dir, target);
        const found = this.findSource(path) ?? this.sourceForOutput(path);
        return found ? { kind: 'file', path: found } : { kind: 'unresolved', dir };
      }
      if (dir === '') return { kind: 'unresolved', dir: dirnameOf(from) };
      dir = dirnameOf(dir);
    }
  }

  private resolveWithTypeScript(specifier: string, from: string) {
    const options: ts.CompilerOptions = {
      ...this.options,
      allowJs: true,
      resolveJsonModule: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    };
    const result = ts.resolveModuleName(specifier, toAbsolute(from), options, this.host);
    const resolved = result.resolvedModule;
    if (!resolved) return undefined;
    const relative = toRelative(resolved.resolvedFileName);
    // Workspace packages come back as their real folders; anything else in node_modules is npm's
    if (relative === undefined || relative.split('/').includes('node_modules')) return undefined;
    // TypeScript prefers declaration files; the program runs the source next to them
    if (relative.endsWith('.d.ts')) return this.sourceForDeclaration(relative);
    return relative;
  }

  private sourceForDeclaration(path: string) {
    const stem = path.slice(0, -'.d.ts'.length);
    for (const extension of SOURCE_EXTENSIONS) {
      if (this.snapshot.has(stem + extension)) return stem + extension;
    }
    return this.sourceForOutput(path);
  }

  /**
   * A workspace package's entry usually points at build output that isn't committed, so this
   * looks for the source: through `exports` (with subpaths), the manifest's entries mapped from
   * its tsconfig's outDir to rootDir or from dist/ to src/, then src/index.
   */
  private resolveWorkspaceEntry(dir: string, subpath: string) {
    const manifest = parseJson(this.snapshot.read(joinPath(dir, 'package.json')));
    const entries: string[] = [];
    const exported = matchSubpath(manifest?.exports, subpath ? `./${subpath}` : '.');
    if (exported !== undefined) entries.push(exported);
    if (subpath) entries.push(subpath, joinPath('src', subpath));
    else entries.push(...manifestEntries(manifest), 'src/index', 'index');

    const packageResolver = new Resolver(this.snapshot, dir, joinPath(dir, 'tsconfig.json'));
    for (const entry of entries) {
      const path = joinPath(dir, entry);
      const found =
        this.findSource(path) ??
        packageResolver.sourceForOutput(path) ??
        this.findSource(joinPath(dir, entry.replace(/^(\.\/)?(dist|lib|build|out)\//, 'src/')));
      if (found) return found;
    }
    return undefined;
  }

  /** The source for a path in the tsconfig's outDir: the same path in its rootDir */
  sourceForOutput(path: string) {
    const { outDir, rootDir } = this.options;
    if (!outDir) return undefined;
    const out = toRelative(outDir);
    const root = rootDir
      ? toRelative(rootDir)
      : this.tsconfig
        ? dirnameOf(this.tsconfig)
        : undefined;
    if (out === undefined || root === undefined) return undefined;
    if (path !== out && !path.startsWith(`${out}/`)) return undefined;
    return this.findSource(joinPath(root, path.slice(out.length)));
  }

  /** Finds the source file for a path that may name build output or omit the extension */
  findSource(candidate: string) {
    const stem = candidate.replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '');
    for (const extension of SOURCE_EXTENSIONS) {
      if (this.snapshot.has(stem + extension)) return stem + extension;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      if (this.snapshot.has(`${candidate}/index${extension}`)) {
        return `${candidate}/index${extension}`;
      }
    }
    return undefined;
  }

  private existingAncestor(path: string) {
    let current = dirnameOf(path);
    while (current !== '' && !this.snapshot.isDirectory(current)) current = dirnameOf(current);
    return current;
  }
}

/**
 * Looks up `key` in an `exports` or `imports` map, with `*` patterns and conditions, returning
 * the first target string Node.js would use
 */
function matchSubpath(map: unknown, key: string): string | undefined {
  if (map === undefined || map === null) return undefined;
  if (typeof map === 'string' || Array.isArray(map)) {
    return key === '.' ? pickTarget(map) : undefined;
  }
  if (typeof map !== 'object') return undefined;
  const entries = map as Record<string, unknown>;
  const isConditions = Object.keys(entries).every(
    (name) => !name.startsWith('.') && !name.startsWith('#'),
  );
  if (isConditions) return key === '.' ? pickTarget(entries) : undefined;
  if (key in entries) return pickTarget(entries[key]);
  for (const [pattern, target] of Object.entries(entries)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    const fits =
      key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length;
    if (fits) {
      const replacement = key.slice(prefix.length, key.length - suffix.length);
      return pickTarget(target)?.replace(/\*/g, replacement);
    }
  }
  return undefined;
}

function pickTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const option of target) {
      const picked = pickTarget(option);
      if (picked !== undefined) return picked;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    const conditions = target as Record<string, unknown>;
    for (const condition of CONDITIONS) {
      if (condition in conditions) {
        const picked = pickTarget(conditions[condition]);
        if (picked !== undefined) return picked;
      }
    }
  }
  return undefined;
}

export function packageName(specifier: string) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Finds `fileName` in `dir` or the nearest folder above it */
export function findUp(snapshot: Snapshot, dir: string, fileName: string) {
  let current = dir;
  while (true) {
    const candidate = joinPath(current, fileName);
    if (snapshot.has(candidate)) return candidate;
    if (current === '') return undefined;
    current = dirnameOf(current);
  }
}

const workspaceIndex = new WeakMap<Snapshot, Map<string, string>>();

/**
 * Workspace packages by name, mapped to their folders; built once per snapshot. Only packages
 * a workspace declares count (package.json `workspaces`, or pnpm-workspace.yaml `packages`):
 * a package.json elsewhere (a fixture, a vendored copy) doesn't stand in for the npm package of
 * the same name. The first of two with the same name wins.
 */
export function workspacePackagesOf(snapshot: Snapshot) {
  let packages = workspaceIndex.get(snapshot);
  if (!packages) {
    packages = new Map();
    const globs: { root: string; patterns: string[] }[] = [];
    for (const path of snapshot.paths) {
      if (path.split('/').includes('node_modules')) continue;
      const root = dirnameOf(path);
      if (path === 'package.json' || path.endsWith('/package.json')) {
        const workspaces = parseJson(snapshot.read(path))?.workspaces;
        const list = Array.isArray(workspaces)
          ? workspaces
          : (workspaces as { packages?: unknown } | undefined)?.packages;
        if (Array.isArray(list))
          globs.push({ root, patterns: list.filter((item) => typeof item === 'string') });
      } else if (path === 'pnpm-workspace.yaml' || path.endsWith('/pnpm-workspace.yaml')) {
        const list = parsePnpmWorkspace(snapshot.read(path));
        globs.push({ root, patterns: list });
      }
    }
    for (const path of snapshot.paths) {
      if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
      if (path.split('/').includes('node_modules')) continue;
      const dir = dirnameOf(path);
      const member = globs.some(({ root, patterns }) => {
        if (!isInside(dir, root) || dir === root) return false;
        const relative = root === '' ? dir : dir.slice(root.length + 1);
        const included = patterns.filter((pattern) => !pattern.startsWith('!'));
        const excluded = patterns
          .filter((pattern) => pattern.startsWith('!'))
          .map((pattern) => pattern.slice(1));
        return (
          matchesAnyGlob(included.map(trimGlob), relative) &&
          !matchesAnyGlob(excluded.map(trimGlob), relative)
        );
      });
      if (!member) continue;
      const manifest = parseJson(snapshot.read(path));
      if (typeof manifest?.name === 'string' && !packages.has(manifest.name)) {
        packages.set(manifest.name, dir);
      }
    }
    workspaceIndex.set(snapshot, packages);
  }
  return packages;
}

function trimGlob(pattern: string) {
  return pattern.replace(/^\.\//, '').replace(/\/$/, '');
}

function parsePnpmWorkspace(text: string | undefined) {
  try {
    const parsed = parseYaml(text ?? '') as { packages?: unknown } | null;
    return Array.isArray(parsed?.packages)
      ? parsed.packages.filter((item) => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function manifestEntries(manifest: Record<string, unknown> | undefined) {
  if (!manifest) return [];
  const entries: string[] = [];
  for (const field of ['source', 'types', 'module', 'main']) {
    if (typeof manifest[field] === 'string') entries.push(manifest[field] as string);
  }
  return entries;
}

export function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True when `path` is a file the program's own code could be in */
export function isSourcePath(path: string) {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}
