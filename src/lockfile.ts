import { parseSyml } from '@yarnpkg/parsers';
import { parse as parseYaml } from 'yaml';
import { parseJson } from './analysis/resolve.ts';
import { dirnameOf, isInside, joinPath, type Snapshot } from './snapshot.ts';

/*
 * Lockfiles are compared by what they resolve, not by their text: each one is read into the same
 * graph (which version each workspace folder gets for each dependency, and what each package
 * version depends on), so a project is affected only when a package it actually loads, directly
 * or through other packages, resolves to a different version.
 */

export interface LockNode {
  name: string;
  version: string;
  /**
   * Everything that pins what gets installed: the version, plus where it comes from and its
   * checksum, so a git dependency moving to another commit or a changed patch counts too
   */
  identity: string;
  dependencies: string[];
}

export interface LockGraph {
  /** Repo-relative path of the lockfile */
  path: string;
  /** Repo-relative workspace folder → dependency name → node id */
  importers: Map<string, Map<string, string>>;
  nodes: Map<string, LockNode>;
}

const LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
];

export class LockfileError extends Error {}

/** Finds the lockfile serving `dir` (the nearest one in it or above it) */
export function findLockfile(snapshot: Snapshot, dir: string) {
  let current = dir;
  while (true) {
    for (const name of LOCKFILES) {
      const candidate = joinPath(current, name);
      if (snapshot.has(candidate)) return candidate;
    }
    if (current === '') return undefined;
    current = dirnameOf(current);
  }
}

export function readLockfile(snapshot: Snapshot, path: string): LockGraph {
  const text = snapshot.read(path) ?? '';
  const dir = dirnameOf(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'pnpm-lock.yaml') return readPnpm(path, dir, text);
  if (name === 'yarn.lock') return readYarn(snapshot, path, dir, text);
  if (name === 'bun.lock') return readBun(path, dir, text);
  if (name === 'bun.lockb')
    throw new LockfileError(`${path}: the binary bun.lockb can't be read; bun.lock can`);
  return readNpm(path, dir, text);
}

/** True when the lockfile resolves a package of this name anywhere */
export function hasPackage(graph: LockGraph, name: string) {
  return nodesNamed(graph, name).length > 0;
}

function identityOf(version: unknown, ...sources: unknown[]) {
  return [
    String(version),
    ...sources.filter((source) => typeof source === 'string' && source),
  ].join(' ');
}

/** The package versions reachable from `names` as loaded by code in `fromFile` */
export function packageClosure(graph: LockGraph, fromFiles: Map<string, Set<string>>) {
  const roots = new Set<string>();
  for (const [name, files] of fromFiles) {
    for (const file of files) {
      const id = lookupDependency(graph, name, file);
      if (id) roots.add(id);
      else for (const nodeId of nodesNamed(graph, name)) roots.add(nodeId);
    }
  }
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of graph.nodes.get(id)?.dependencies ?? []) stack.push(dependency);
  }
  return seen;
}

function lookupDependency(graph: LockGraph, name: string, file: string) {
  let best: string | undefined;
  for (const dir of graph.importers.keys()) {
    if (isInside(file, dir) && (best === undefined || dir.length > best.length)) best = dir;
  }
  const fromImporter = best === undefined ? undefined : graph.importers.get(best)?.get(name);
  if (fromImporter) return fromImporter;
  // Hoisted packages that aren't declared by the importing workspace
  return graph.importers.get(dirnameOf(graph.path))?.get(name);
}

const nodesByName = new WeakMap<LockGraph, Map<string, string[]>>();

function nodesNamed(graph: LockGraph, name: string) {
  let index = nodesByName.get(graph);
  if (!index) {
    index = new Map();
    for (const [id, node] of graph.nodes) {
      const ids = index.get(node.name) ?? [];
      ids.push(id);
      index.set(node.name, ids);
    }
    nodesByName.set(graph, index);
  }
  return index.get(name) ?? [];
}

type Dependencies = Record<string, string> | undefined;

function dependencyNames(entry: Record<string, unknown>, includeDev: boolean) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  if (includeDev) fields.push('devDependencies');
  const names: Record<string, string> = {};
  for (const field of fields) Object.assign(names, (entry[field] as Dependencies) ?? {});
  return names;
}

// npm: package-lock.json v2/v3, keyed by install location

function readNpm(path: string, dir: string, text: string): LockGraph {
  const lock = parseJson(text);
  const packages = lock?.packages as Record<string, Record<string, unknown>> | undefined;
  if (!packages) {
    throw new LockfileError(`${path}: only lockfileVersion 2 and 3 are supported`);
  }
  const graph: LockGraph = { path, importers: new Map(), nodes: new Map() };

  const resolveFrom = (location: string, name: string) => {
    let base = location;
    while (true) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      const entry = packages[candidate];
      if (entry) return entry.link ? undefined : candidate;
      if (base === '') return undefined;
      const index = base.lastIndexOf('node_modules/');
      base = index <= 0 ? '' : base.slice(0, index - 1);
    }
  };

  for (const [location, entry] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) {
      const importer = new Map<string, string>();
      for (const name of Object.keys(dependencyNames(entry, true))) {
        const resolved = resolveFrom(location, name);
        if (resolved) importer.set(name, resolved);
      }
      graph.importers.set(joinPath(dir, location), importer);
      continue;
    }
    if (entry.link) continue;
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dependencies = Object.keys(dependencyNames(entry, false))
      .map((dependency) => resolveFrom(location, dependency))
      .filter((resolved): resolved is string => resolved !== undefined);
    graph.nodes.set(location, {
      name,
      version: String(entry.version),
      identity: identityOf(entry.version, entry.resolved, entry.integrity),
      dependencies,
    });
  }
  return graph;
}

// yarn: classic (v1) and berry (v2+) lockfiles, keyed by descriptor

function readYarn(snapshot: Snapshot, path: string, dir: string, text: string): LockGraph {
  const lock = parseSyml(text) as Record<string, Record<string, unknown>>;
  const isBerry = '__metadata' in lock;
  const graph: LockGraph = { path, importers: new Map(), nodes: new Map() };
  const byDescriptor = new Map<string, string>();
  const workspaceIds = new Map<string, string>();

  for (const [keys, entry] of Object.entries(lock)) {
    if (keys === '__metadata') continue;
    const resolution = isBerry ? String(entry.resolution) : undefined;
    const firstDescriptor = keys.split(',')[0].trim();
    const name = descriptorName(firstDescriptor);
    const id = resolution ?? `${name}@${entry.version}`;
    for (const descriptor of keys.split(',')) byDescriptor.set(descriptor.trim(), id);
    const workspace = resolution?.match(/@workspace:(.*)$/)?.[1];
    if (workspace !== undefined) {
      workspaceIds.set(id, joinPath(dir, workspace));
      continue;
    }
    graph.nodes.set(id, {
      name,
      version: String(entry.version),
      // Berry's resolution carries patch hashes and git commits; classic has resolved URLs
      identity: identityOf(
        entry.version,
        resolution ?? entry.resolved,
        entry.checksum ?? entry.integrity,
      ),
      dependencies: [],
    });
  }

  const resolve = (name: string, range: string) => {
    const id = byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);
    return id && !workspaceIds.has(id) ? id : undefined;
  };

  for (const [keys, entry] of Object.entries(lock)) {
    if (keys === '__metadata') continue;
    const id = byDescriptor.get(keys.split(',')[0].trim()) as string;
    const resolved = Object.entries(dependencyNames(entry, false))
      .map(([name, range]) => resolve(name, range))
      .filter((dependency): dependency is string => dependency !== undefined);
    const workspaceDir = workspaceIds.get(id);
    if (workspaceDir !== undefined) {
      graph.importers.set(workspaceDir, importerFrom(entry, resolve));
    } else {
      (graph.nodes.get(id) as LockNode).dependencies = resolved;
    }
  }

  // Classic lockfiles don't list workspaces; their manifests say what each one depends on
  if (!isBerry) {
    for (const manifestPath of snapshot.paths) {
      if (!manifestPath.endsWith('package.json') || !isInside(manifestPath, dir)) continue;
      if (manifestPath.split('/').includes('node_modules')) continue;
      if (manifestPath !== 'package.json' && !manifestPath.endsWith('/package.json')) continue;
      const manifest = parseJson(snapshot.read(manifestPath));
      if (manifest) graph.importers.set(dirnameOf(manifestPath), importerFrom(manifest, resolve));
    }
  }
  return graph;
}

function importerFrom(
  entry: Record<string, unknown>,
  resolve: (name: string, range: string) => string | undefined,
) {
  const importer = new Map<string, string>();
  for (const [name, range] of Object.entries(dependencyNames(entry, true))) {
    const id = resolve(name, range);
    if (id) importer.set(name, id);
  }
  return importer;
}

/** "@scope/name@range" → "@scope/name" */
function descriptorName(descriptor: string) {
  const unquoted = descriptor.replace(/^"|"$/g, '');
  const at = unquoted.indexOf('@', 1);
  return at === -1 ? unquoted : unquoted.slice(0, at);
}

// pnpm: v6 and v9 lockfiles

function readPnpm(path: string, dir: string, text: string): LockGraph {
  const lock = (parseYaml(text) ?? {}) as Record<string, unknown>;
  if (Number.parseFloat(String(lock.lockfileVersion)) < 6) {
    throw new LockfileError(`${path}: only lockfileVersion 6 and later are supported`);
  }
  const packageInfo = (lock.packages ?? {}) as Record<
    string,
    { resolution?: Record<string, unknown> }
  >;
  const graph: LockGraph = { path, importers: new Map(), nodes: new Map() };
  const snapshots = (lock.snapshots ?? lock.packages ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const nodeId = (name: string, version: unknown) => {
    const value =
      typeof version === 'object' && version ? (version as { version: unknown }).version : version;
    const text = String(value).replace(/^\//, '');
    if (text.startsWith('link:') || text.startsWith('file:')) return undefined;
    // A version never contains "@", so one before any peer suffix means an alias that records
    // the real "name@version"
    const withoutPeers = text.split('(')[0];
    return withoutPeers.includes('@') ? text : `${name}@${text}`;
  };

  for (const [key, entry] of Object.entries(snapshots)) {
    const id = key.replace(/^\//, '');
    const { name, version } = splitPnpmId(id);
    const dependencies = Object.entries(dependencyNames(entry ?? {}, false))
      .map(([dependency, version]) => nodeId(dependency, version))
      .filter((resolved): resolved is string => resolved !== undefined);
    // The id carries peers and patch hashes; the resolution pins tarballs and git commits
    const resolution = (packageInfo[key] ?? packageInfo[key.split('(')[0]] ?? {}).resolution ?? {};
    const identity = identityOf(
      version,
      id,
      resolution.integrity,
      resolution.tarball,
      resolution.commit,
      resolution.repo,
    );
    graph.nodes.set(id, { name, version, identity, dependencies });
  }

  const importers = (lock.importers ?? { '.': lock }) as Record<string, Record<string, unknown>>;
  for (const [importerDir, entry] of Object.entries(importers)) {
    const importer = new Map<string, string>();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = (entry[field] ?? {}) as Record<string, unknown>;
      for (const [name, version] of Object.entries(dependencies)) {
        const id = nodeId(name, version);
        if (id) importer.set(name, id);
      }
    }
    graph.importers.set(joinPath(dir, importerDir), importer);
  }
  return graph;
}

// bun: the text bun.lock (JSON with trailing commas)

function readBun(path: string, dir: string, text: string): LockGraph {
  let lock: {
    workspaces?: Record<string, Record<string, unknown>>;
    packages?: Record<string, unknown[]>;
  };
  try {
    lock = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    throw new LockfileError(`${path}: couldn't be parsed`);
  }
  const graph: LockGraph = { path, importers: new Map(), nodes: new Map() };
  const packages = lock.packages ?? {};
  // Keys are install paths ("a", or "b/a" for a nested copy); entries start with "name@version"
  const resolveFrom = (key: string, name: string) => {
    let base = key;
    while (true) {
      const candidate = base ? `${base}/${name}` : name;
      if (packages[candidate]) return candidate;
      if (!base) return undefined;
      const slash = base.lastIndexOf('/');
      base = slash === -1 ? '' : base.slice(0, slash);
    }
  };
  for (const [key, entry] of Object.entries(packages)) {
    const spec = String(entry[0] ?? '');
    const at = spec.lastIndexOf('@');
    if (at <= 0 || spec.slice(at + 1).startsWith('workspace:')) continue;
    const info = (entry.find((part) => part && typeof part === 'object') ?? {}) as Record<
      string,
      unknown
    >;
    const dependencies = Object.keys(dependencyNames(info, false))
      .map((dependency) => resolveFrom(key, dependency))
      .filter((resolved): resolved is string => resolved !== undefined);
    const checksum = entry.find((part) => typeof part === 'string' && part.startsWith('sha'));
    graph.nodes.set(key, {
      name: spec.slice(0, at),
      version: spec.slice(at + 1),
      identity: identityOf(spec.slice(at + 1), checksum),
      dependencies,
    });
  }
  for (const [workspaceDir, workspace] of Object.entries(lock.workspaces ?? {})) {
    const importer = new Map<string, string>();
    for (const name of Object.keys(dependencyNames(workspace, true))) {
      const resolved = resolveFrom('', name);
      if (resolved && graph.nodes.has(resolved)) importer.set(name, resolved);
    }
    graph.importers.set(joinPath(dir, workspaceDir), importer);
  }
  return graph;
}

/** "@scope/name@1.2.3(peer@1)" → name and version */
function splitPnpmId(id: string) {
  const peers = id.indexOf('(');
  const plain = peers === -1 ? id : id.slice(0, peers);
  const at = plain.lastIndexOf('@');
  if (at <= 0) return { name: plain, version: '' };
  return { name: plain.slice(0, at), version: id.slice(at + 1) };
}
