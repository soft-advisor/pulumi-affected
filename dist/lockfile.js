import { parseSyml } from '@yarnpkg/parsers';
import { parse as parseYaml } from 'yaml';
import { parseJson } from "./analysis/resolve.js";
import { dirnameOf, isInside, joinPath } from "./snapshot.js";
const LOCKFILES = [
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'bun.lock',
    'bun.lockb',
];
export class LockfileError extends Error {
}
const LOCKFILES_BY_MANAGER = {
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    bun: ['bun.lock', 'bun.lockb'],
};
/**
 * Finds the lockfile serving `dir`: the nearest folder in or above it with one. When a folder
 * has several (a leftover yarn.lock next to package-lock.json), `packageManager` in its
 * package.json decides; without it, the choice is reported.
 */
export function findLockfile(snapshot, dir, warnings = []) {
    let current = dir;
    while (true) {
        const present = LOCKFILES.map((name) => joinPath(current, name)).filter((path) => snapshot.has(path));
        if (present.length === 1)
            return present[0];
        if (present.length > 1) {
            const manifest = parseJson(snapshot.read(joinPath(current, 'package.json')));
            const manager = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
            const chosen = present.find((path) => (LOCKFILES_BY_MANAGER[manager] ?? []).some((name) => path.endsWith(name)));
            if (chosen)
                return chosen;
            warnings.push(`${present.join(' and ')} are both present; using ${present[0]} (set packageManager in package.json to choose)`);
            return present[0];
        }
        if (current === '')
            return undefined;
        current = dirnameOf(current);
    }
}
export function readLockfile(snapshot, path) {
    const text = snapshot.read(path) ?? '';
    const dir = dirnameOf(path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name === 'pnpm-lock.yaml')
        return readPnpm(path, dir, text);
    if (name === 'yarn.lock')
        return readYarn(snapshot, path, dir, text);
    if (name === 'bun.lock')
        return readBun(path, dir, text);
    if (name === 'bun.lockb')
        throw new LockfileError(`${path}: the binary bun.lockb can't be read; bun.lock can`);
    return readNpm(path, dir, text);
}
/** True when the lockfile resolves a package of this name anywhere, under its name or an alias */
export function hasPackage(graph, name) {
    if (nodesNamed(graph, name).length > 0)
        return true;
    for (const importer of graph.importers.values())
        if (importer.has(name))
            return true;
    return false;
}
/**
 * A registry tarball: "<registry>/<name>/-/<name>-<version>.tgz". Registry versions never change
 * once published, so for these the version is the identity; the URL and checksum change when a
 * mirror or the checksum format does, which mustn't select every project.
 */
function isRegistryTarball(resolved) {
    return typeof resolved === 'string' && /^https?:\/\/.*\/-\/[^/]+\.tgz(#.*)?$/.test(resolved);
}
function identityOf(version, ...sources) {
    return [
        String(version),
        ...sources.filter((source) => typeof source === 'string' && source),
    ].join(' ');
}
/** The package versions reachable from `names` as loaded by code in `fromFile` */
export function packageClosure(graph, fromFiles) {
    const roots = new Set();
    for (const [name, files] of fromFiles) {
        for (const file of files) {
            const id = lookupDependency(graph, name, file);
            if (id)
                roots.add(id);
            else
                for (const nodeId of nodesNamed(graph, name))
                    roots.add(nodeId);
        }
    }
    const seen = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        const id = stack.pop();
        if (seen.has(id))
            continue;
        seen.add(id);
        for (const dependency of graph.nodes.get(id)?.dependencies ?? [])
            stack.push(dependency);
    }
    return seen;
}
function lookupDependency(graph, name, file) {
    let best;
    for (const dir of graph.importers.keys()) {
        if (isInside(file, dir) && (best === undefined || dir.length > best.length))
            best = dir;
    }
    const fromImporter = best === undefined ? undefined : graph.importers.get(best)?.get(name);
    if (fromImporter)
        return fromImporter;
    // Hoisted packages that aren't declared by the importing workspace
    return graph.importers.get(dirnameOf(graph.path))?.get(name);
}
const nodesByName = new WeakMap();
function nodesNamed(graph, name) {
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
function dependencyNames(entry, includeDev) {
    const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
    if (includeDev)
        fields.push('devDependencies');
    const names = {};
    for (const field of fields)
        Object.assign(names, entry[field] ?? {});
    return names;
}
// npm: package-lock.json v2/v3, keyed by install location
function readNpm(path, dir, text) {
    const lock = parseJson(text);
    const packages = lock?.packages;
    if (!packages) {
        throw new LockfileError(`${path}: only lockfileVersion 2 and 3 are supported`);
    }
    const graph = { path, importers: new Map(), nodes: new Map() };
    const resolveFrom = (location, name) => {
        let base = location;
        while (true) {
            const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
            const entry = packages[candidate];
            if (entry)
                return entry.link ? undefined : candidate;
            if (base === '')
                return undefined;
            const index = base.lastIndexOf('node_modules/');
            base = index <= 0 ? '' : base.slice(0, index - 1);
        }
    };
    for (const [location, entry] of Object.entries(packages)) {
        if (!location.includes('node_modules/')) {
            const importer = new Map();
            for (const name of Object.keys(dependencyNames(entry, true))) {
                const resolved = resolveFrom(location, name);
                if (resolved)
                    importer.set(name, resolved);
            }
            graph.importers.set(joinPath(dir, location), importer);
            continue;
        }
        if (entry.link)
            continue;
        const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const dependencies = Object.keys(dependencyNames(entry, false))
            .map((dependency) => resolveFrom(location, dependency))
            .filter((resolved) => resolved !== undefined);
        graph.nodes.set(location, {
            name,
            version: String(entry.version),
            identity: isRegistryTarball(entry.resolved)
                ? identityOf(entry.version)
                : identityOf(entry.version, entry.resolved, entry.integrity),
            dependencies,
        });
    }
    return graph;
}
// yarn: classic (v1) and berry (v2+) lockfiles, keyed by descriptor
function readYarn(snapshot, path, dir, text) {
    const lock = parseSyml(text);
    const isBerry = '__metadata' in lock;
    const graph = { path, importers: new Map(), nodes: new Map() };
    const byDescriptor = new Map();
    const workspaceIds = new Map();
    for (const [keys, entry] of Object.entries(lock)) {
        if (keys === '__metadata')
            continue;
        const resolution = isBerry ? String(entry.resolution) : undefined;
        const firstDescriptor = keys.split(',')[0].trim();
        const name = descriptorName(firstDescriptor);
        const id = resolution ?? `${name}@${entry.version}`;
        for (const descriptor of keys.split(','))
            byDescriptor.set(descriptor.trim(), id);
        const workspace = resolution?.match(/@workspace:(.*)$/)?.[1];
        if (workspace !== undefined) {
            workspaceIds.set(id, joinPath(dir, workspace));
            continue;
        }
        graph.nodes.set(id, {
            name,
            version: String(entry.version),
            // Berry's resolution carries patch hashes and git commits; classic has resolved URLs
            identity: (resolution !== undefined && /@npm:/.test(resolution)) || isRegistryTarball(entry.resolved)
                ? identityOf(entry.version, resolution)
                : identityOf(entry.version, resolution ?? entry.resolved, entry.checksum ?? entry.integrity),
            dependencies: [],
        });
    }
    const resolve = (name, range) => {
        const id = byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);
        return id && !workspaceIds.has(id) ? id : undefined;
    };
    for (const [keys, entry] of Object.entries(lock)) {
        if (keys === '__metadata')
            continue;
        const id = byDescriptor.get(keys.split(',')[0].trim());
        const resolved = Object.entries(dependencyNames(entry, false))
            .map(([name, range]) => resolve(name, range))
            .filter((dependency) => dependency !== undefined);
        const workspaceDir = workspaceIds.get(id);
        if (workspaceDir !== undefined) {
            graph.importers.set(workspaceDir, importerFrom(entry, resolve));
        }
        else {
            graph.nodes.get(id).dependencies = resolved;
        }
    }
    // Classic lockfiles don't list workspaces; their manifests say what each one depends on
    if (!isBerry) {
        for (const manifestPath of snapshot.paths) {
            if (!manifestPath.endsWith('package.json') || !isInside(manifestPath, dir))
                continue;
            if (manifestPath.split('/').includes('node_modules'))
                continue;
            if (manifestPath !== 'package.json' && !manifestPath.endsWith('/package.json'))
                continue;
            const manifest = parseJson(snapshot.read(manifestPath));
            if (manifest)
                graph.importers.set(dirnameOf(manifestPath), importerFrom(manifest, resolve));
        }
    }
    return graph;
}
function importerFrom(entry, resolve) {
    const importer = new Map();
    for (const [name, range] of Object.entries(dependencyNames(entry, true))) {
        const id = resolve(name, range);
        if (id)
            importer.set(name, id);
    }
    return importer;
}
/** "@scope/name@range" → "@scope/name" */
function descriptorName(descriptor) {
    const unquoted = descriptor.replace(/^"|"$/g, '');
    const at = unquoted.indexOf('@', 1);
    return at === -1 ? unquoted : unquoted.slice(0, at);
}
// pnpm: v6 and v9 lockfiles
function readPnpm(path, dir, text) {
    const lock = (parseYaml(text) ?? {});
    if (Number.parseFloat(String(lock.lockfileVersion)) < 6) {
        throw new LockfileError(`${path}: only lockfileVersion 6 and later are supported`);
    }
    const packageInfo = (lock.packages ?? {});
    const graph = { path, importers: new Map(), nodes: new Map() };
    const snapshots = (lock.snapshots ?? lock.packages ?? {});
    const nodeId = (name, version) => {
        const value = typeof version === 'object' && version ? version.version : version;
        const text = String(value).replace(/^\//, '');
        if (text.startsWith('link:') || text.startsWith('file:'))
            return undefined;
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
            .filter((resolved) => resolved !== undefined);
        // The id carries peers and patch hashes; the resolution pins tarballs and git commits
        const resolution = (packageInfo[key] ?? packageInfo[key.split('(')[0]] ?? {}).resolution ?? {};
        // From the registry, a resolution is only a checksum
        const fromRegistry = !resolution.tarball && !resolution.commit && !resolution.repo;
        const packageId = pnpmPackageIdentity(id);
        const identity = fromRegistry
            ? identityOf(version, packageId)
            : identityOf(version, packageId, resolution.integrity, resolution.tarball, resolution.commit, resolution.repo);
        graph.nodes.set(id, { name, version, identity, dependencies });
    }
    const importers = (lock.importers ?? { '.': lock });
    for (const [importerDir, entry] of Object.entries(importers)) {
        const importer = new Map();
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            const dependencies = (entry[field] ?? {});
            for (const [name, version] of Object.entries(dependencies)) {
                const id = nodeId(name, version);
                if (id)
                    importer.set(name, id);
            }
        }
        graph.importers.set(joinPath(dir, importerDir), importer);
    }
    return graph;
}
// bun: the text bun.lock (JSON with trailing commas)
function readBun(path, dir, text) {
    let lock;
    try {
        lock = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
    }
    catch {
        throw new LockfileError(`${path}: couldn't be parsed`);
    }
    const graph = { path, importers: new Map(), nodes: new Map() };
    const packages = lock.packages ?? {};
    // Keys are install paths ("a", or "b/a" for a nested copy); entries start with "name@version"
    const resolveFrom = (key, name) => {
        let base = key;
        while (true) {
            const candidate = base ? `${base}/${name}` : name;
            if (packages[candidate])
                return candidate;
            if (!base)
                return undefined;
            const slash = base.lastIndexOf('/');
            base = slash === -1 ? '' : base.slice(0, slash);
        }
    };
    for (const [key, entry] of Object.entries(packages)) {
        const spec = String(entry[0] ?? '');
        const at = spec.lastIndexOf('@');
        if (at <= 0 || spec.slice(at + 1).startsWith('workspace:'))
            continue;
        const info = (entry.find((part) => part && typeof part === 'object') ?? {});
        const dependencies = Object.keys(dependencyNames(info, false))
            .map((dependency) => resolveFrom(key, dependency))
            .filter((resolved) => resolved !== undefined);
        const checksum = entry.find((part) => typeof part === 'string' && part.startsWith('sha'));
        graph.nodes.set(key, {
            name: spec.slice(0, at),
            version: spec.slice(at + 1),
            identity: identityOf(spec.slice(at + 1), checksum),
            dependencies,
        });
    }
    for (const [workspaceDir, workspace] of Object.entries(lock.workspaces ?? {})) {
        const importer = new Map();
        // A workspace's own copy of a dependency is keyed under the workspace's package name
        const workspaceName = typeof workspace.name === 'string' && workspaceDir !== '' ? workspace.name : '';
        for (const name of Object.keys(dependencyNames(workspace, true))) {
            const resolved = resolveFrom(workspaceName, name);
            if (resolved && graph.nodes.has(resolved))
                importer.set(name, resolved);
        }
        graph.importers.set(joinPath(dir, workspaceDir), importer);
    }
    return graph;
}
/** "@scope/name@1.2.3(peer@1)" → name and version */
function splitPnpmId(id) {
    const peers = id.indexOf('(');
    const plain = peers === -1 ? id : id.slice(0, peers);
    const at = plain.lastIndexOf('@');
    if (at <= 0)
        return { name: plain, version: '' };
    return { name: plain.slice(0, at), version: plain.slice(at + 1) };
}
/**
 * The parts of a pnpm id that are the package itself: the name, version and any patch hash. Peer
 * resolutions in parentheses are left out; the peers are packages of their own in the closure,
 * so an unrelated peer of a peer (a type package) changing doesn't make this one look changed.
 */
function pnpmPackageIdentity(id) {
    const patch = /\(patch_hash=[^)]*\)/.exec(id)?.[0] ?? '';
    const peers = id.indexOf('(');
    return `${peers === -1 ? id : id.slice(0, peers)}${patch}`;
}
