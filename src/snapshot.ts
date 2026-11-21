import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The repository's files at one point in time: a commit, or the working tree. Paths are
 * repo-relative and use forward slashes. Hashes are git blob ids, so the same content has the
 * same hash in every snapshot and unchanged files can be skipped cheaply.
 *
 * Symbolic links are followed while they stay inside the repository, for files and folders
 * alike; one that points outside reads as its target path, as git stores it, so nothing outside
 * the repository is ever read. Submodules appear as entries whose hash is their commit.
 */
export interface Snapshot {
  /** A commit SHA, or "working tree" */
  readonly label: string;
  /** Every file, link and submodule, by its own path */
  readonly paths: readonly string[];
  has(path: string): boolean;
  isDirectory(path: string): boolean;
  read(path: string): string | undefined;
  hash(path: string): string | undefined;
  /** The path with links resolved, or undefined when it leaves the repository */
  realPath(path: string): string | undefined;
}

const MAX_GIT_OUTPUT = 512 * 1024 * 1024;
const MAX_LINK_HOPS = 40;

/** Files worth reading ahead in one batch when a commit is first read */
const PREFETCH = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/;

export function git(repoRoot: string, args: string[], input?: string) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function repoRootOf(cwd: string) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function resolveCommit(repoRoot: string, rev: string) {
  // A revision from an input or event must never be read as an option
  return git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
}

type Entry =
  | { kind: 'file'; id?: string }
  | { kind: 'link'; id: string; target: string }
  /** A submodule; its id is the commit it's at */
  | { kind: 'submodule'; id: string };

abstract class BaseSnapshot implements Snapshot {
  abstract readonly label: string;
  protected abstract readonly entries: Map<string, Entry>;
  protected abstract readFile(path: string, entry: Entry): string;
  protected abstract idOf(path: string, entry: Entry): string;

  private directories: Set<string> | undefined;

  get paths(): readonly string[] {
    return [...this.entries.keys()];
  }

  realPath(path: string): string | undefined {
    let current = trimSlashes(path);
    for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
      const parts = current.split('/');
      let resolved = false;
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join('/');
        const entry = this.entries.get(prefix);
        if (entry?.kind !== 'link') continue;
        const target = resolveLink(dirnameOf(prefix), entry.target);
        if (target === undefined) return undefined;
        current = joinPath(target, ...parts.slice(index));
        resolved = true;
        break;
      }
      if (!resolved) return current;
    }
    return undefined;
  }

  has(path: string) {
    const real = this.realPath(path);
    return real !== undefined && this.entries.get(real)?.kind === 'file';
  }

  hash(path: string) {
    const real = this.realPath(path);
    const target = real === undefined ? undefined : this.entries.get(real);
    if (real !== undefined && target) return this.idOf(real, target);
    // A link leaving the repository is its own content
    const own = this.entries.get(path);
    return own ? this.idOf(path, own) : undefined;
  }

  read(path: string) {
    const real = this.realPath(path);
    const target = real === undefined ? undefined : this.entries.get(real);
    if (real !== undefined && target?.kind === 'file') return this.readFile(real, target);
    const own = this.entries.get(path);
    return own?.kind === 'link' ? own.target : undefined;
  }

  isDirectory(path: string) {
    if (!this.directories) {
      this.directories = new Set(['']);
      for (const file of this.entries.keys()) {
        let slash = file.lastIndexOf('/');
        while (slash > 0) {
          const dir = file.slice(0, slash);
          if (this.directories.has(dir)) break;
          this.directories.add(dir);
          slash = dir.lastIndexOf('/');
        }
      }
    }
    const real = this.realPath(path);
    return real !== undefined && this.directories.has(real);
  }
}

/** Where a link's target points, or undefined when it's absolute or leaves the repository */
function resolveLink(dir: string, target: string) {
  if (target.startsWith('/')) return undefined;
  const parts = dir === '' ? [] : dir.split('/');
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/** Blob contents by id, shared by every snapshot of the process: commits share most files */
const blobContents = new Map<string, string>();

/** Files committed at a revision, read from git's object store */
export class GitSnapshot extends BaseSnapshot {
  readonly label: string;
  protected readonly entries = new Map<string, Entry>();
  private readonly repoRoot: string;
  private prefetched = false;

  constructor(repoRoot: string, commit: string) {
    super();
    this.repoRoot = repoRoot;
    this.label = commit;
    const listing = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]);
    const links: [string, string][] = [];
    for (const record of listing.split('\0')) {
      if (!record) continue;
      // "<mode> <type> <object>\t<path>"
      const tab = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (type === 'commit') this.entries.set(path, { kind: 'submodule', id: object });
      else if (mode === '120000') links.push([path, object]);
      else if (type === 'blob') this.entries.set(path, { kind: 'file', id: object });
    }
    const targets = readBlobs(
      repoRoot,
      links.map(([, id]) => id),
    );
    for (const [path, id] of links) {
      this.entries.set(path, { kind: 'link', id, target: targets.get(id) ?? '' });
    }
  }

  protected idOf(_path: string, entry: Entry) {
    return entry.id ?? '';
  }

  protected readFile(_path: string, entry: Entry) {
    const id = entry.id ?? '';
    if (!blobContents.has(id) && !this.prefetched) {
      // One git process for every source file instead of one per file
      this.prefetched = true;
      const wanted = [...this.entries]
        .filter(([path, other]) => other.kind === 'file' && PREFETCH.test(path))
        .map(([, other]) => other.id ?? '')
        .filter((other) => !blobContents.has(other));
      for (const [blob, content] of readBlobs(this.repoRoot, wanted))
        blobContents.set(blob, content);
    }
    let content = blobContents.get(id);
    if (content === undefined) {
      content = git(this.repoRoot, ['cat-file', 'blob', id]);
      blobContents.set(id, content);
    }
    return content;
  }
}

/** Reads many blobs with one `git cat-file --batch` */
function readBlobs(repoRoot: string, ids: string[]) {
  const contents = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return contents;
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: `${unique.join('\n')}\n`,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    // "<id> <type> <size>", or "<id> missing"
    const [id, type, size] = output.subarray(offset, headerEnd).toString('utf8').split(' ');
    offset = headerEnd + 1;
    if (type === 'missing' || size === undefined) continue;
    const length = Number(size);
    contents.set(id, output.subarray(offset, offset + length).toString('utf8'));
    offset += length + 1;
  }
  return contents;
}

/** Files in the working tree that git tracks or would track, including uncommitted changes */
export class WorktreeSnapshot extends BaseSnapshot {
  readonly label = 'working tree';
  protected readonly entries = new Map<string, Entry>();
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    super();
    this.repoRoot = repoRoot;
    const submodules = new Map<string, string>();
    for (const record of git(repoRoot, ['ls-files', '-z', '--stage']).split('\0')) {
      // "<mode> <object> <stage>\t<path>"
      const tab = record.indexOf('\t');
      const [mode, object] = record.slice(0, tab).split(' ');
      if (mode === '160000') submodules.set(record.slice(tab + 1), object);
    }
    const listing = git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    for (const path of listing.split('\0')) {
      if (!path) continue;
      const submodule = submodules.get(path);
      if (submodule) {
        this.entries.set(path, { kind: 'submodule', id: submodule });
        continue;
      }
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(join(repoRoot, path));
      } catch {
        continue; // Tracked files deleted from the working tree are still listed
      }
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(join(repoRoot, path));
        this.entries.set(path, { kind: 'link', id: gitBlobId(Buffer.from(target)), target });
      } else if (stats.isFile()) {
        this.entries.set(path, { kind: 'file' });
      }
    }
  }

  protected idOf(path: string, entry: Entry) {
    if (entry.id === undefined) entry.id = gitBlobId(readFileSync(join(this.repoRoot, path)));
    return entry.id;
  }

  protected readFile(path: string) {
    return readFileSync(join(this.repoRoot, path), 'utf8');
  }
}

/** The id git gives a blob with this content, so working-tree files compare with committed ones */
function gitBlobId(content: Buffer) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function trimSlashes(path: string) {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Joins repo-relative path segments, resolving "." and "..", where "" is the repo root */
export function joinPath(...segments: string[]) {
  const parts: string[] = [];
  for (const segment of segments.join('/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

export function dirnameOf(path: string) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** True when `path` is `dir` itself or inside it; "" is the repo root */
export function isInside(path: string, dir: string) {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

export function isSha(value: string) {
  return /^[0-9a-f]{40}$/.test(value);
}

/** True when the commit is available locally, fetching it if needed */
export function ensureCommit(repoRoot: string, sha: string) {
  if (!isSha(sha)) return false;
  const exists = () => {
    try {
      git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (exists()) return true;
  try {
    git(repoRoot, ['fetch', '--quiet', '--no-tags', 'origin', sha]);
  } catch {
    return false;
  }
  return exists();
}
