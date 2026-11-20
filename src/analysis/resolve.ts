import { builtinModules } from 'node:module';
import ts from 'typescript';
import { dirnameOf, joinPath, type Snapshot } from '../snapshot.ts';

/*
 * Module resolution runs against a snapshot (a commit or the working tree), not the disk, so the
 * base revision resolves exactly as it was. node_modules isn't committed, so a bare specifier is
 * either a workspace package (resolved to its source) or an npm package (tracked by version
 * through the lockfile).
 */

export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'package'; name: string }
  | { kind: 'builtin' }
  | { kind: 'unresolved' };

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

export class Resolver {
  readonly options: ts.CompilerOptions;
  /** The tsconfig.json used, if any */
  readonly tsconfig: string | undefined;
  private readonly host: ts.ModuleResolutionHost;
  private readonly workspacePackages: Map<string, string>;
  private readonly cache = new Map<string, Resolution>();
  private readonly snapshot: Snapshot;

  constructor(snapshot: Snapshot, projectDir: string) {
    this.snapshot = snapshot;
    this.host = {
      fileExists: (path) => {
        const relative = toRelative(path);
        return relative !== undefined && snapshot.has(relative);
      },
      readFile: (path) => {
        const relative = toRelative(path);
        return relative === undefined ? undefined : snapshot.read(relative);
      },
      directoryExists: (path) => {
        const relative = toRelative(path);
        return relative !== undefined && snapshot.isDirectory(relative);
      },
      realpath: (path) => path,
      getCurrentDirectory: () => toAbsolute(projectDir),
    };
    this.tsconfig = findUp(snapshot, projectDir, 'tsconfig.json');
    this.options = this.tsconfig ? this.readCompilerOptions(this.tsconfig) : {};
    this.workspacePackages = findWorkspacePackages(snapshot);
  }

  private readCompilerOptions(tsconfig: string): ts.CompilerOptions {
    const text = this.snapshot.read(tsconfig) ?? '{}';
    const json = ts.parseConfigFileTextToJson(tsconfig, text).config ?? {};
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

    const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
    const local = this.resolveWithTypeScript(specifier, from);
    if (local) return { kind: 'file', path: local };
    if (isRelative) return { kind: 'unresolved' };

    const name = packageName(specifier);
    const workspaceDir = this.workspacePackages.get(name);
    if (workspaceDir !== undefined) {
      const entry = this.resolveWorkspaceEntry(workspaceDir, specifier.slice(name.length));
      return entry ? { kind: 'file', path: entry } : { kind: 'unresolved' };
    }
    return { kind: 'package', name };
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
    if (!resolved || resolved.isExternalLibraryImport) return undefined;
    const relative = toRelative(resolved.resolvedFileName);
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
    return undefined;
  }

  /**
   * A workspace package's entry usually points at build output that isn't committed, so this
   * looks for the source: the manifest's entry with dist/ mapped to src/, then src/index.
   */
  private resolveWorkspaceEntry(dir: string, subpath: string) {
    const candidates: string[] = [];
    if (subpath) {
      candidates.push(joinPath(dir, subpath), joinPath(dir, 'src', subpath));
    } else {
      const manifest = parseJson(this.snapshot.read(joinPath(dir, 'package.json')));
      for (const entry of manifestEntries(manifest)) {
        candidates.push(joinPath(dir, entry));
        candidates.push(joinPath(dir, entry.replace(/^(\.\/)?(dist|lib|build|out)\//, 'src/')));
      }
      candidates.push(joinPath(dir, 'src/index'), joinPath(dir, 'index'));
    }
    for (const candidate of candidates) {
      const found = this.findSource(candidate);
      if (found) return found;
    }
    return undefined;
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

/** Every package.json name outside node_modules, mapped to its folder */
function findWorkspacePackages(snapshot: Snapshot) {
  const packages = new Map<string, string>();
  for (const path of snapshot.paths) {
    if (!path.endsWith('package.json') || path.split('/').includes('node_modules')) continue;
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    const manifest = parseJson(snapshot.read(path));
    if (typeof manifest?.name === 'string') packages.set(manifest.name, dirnameOf(path));
  }
  return packages;
}

function manifestEntries(manifest: Record<string, unknown> | undefined) {
  if (!manifest) return [];
  const entries: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') entries.push(value);
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) collect(nested);
    }
  };
  const exports = manifest.exports;
  if (exports && typeof exports === 'object' && '.' in exports) collect(exports['.']);
  else collect(exports);
  for (const field of ['source', 'types', 'module', 'main']) collect(manifest[field]);
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
