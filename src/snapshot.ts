import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The repository's files at one point in time: a commit, or the working tree. Paths are
 * repo-relative and use forward slashes. Hashes are git blob ids, so the same content has the
 * same hash in every snapshot and unchanged files can be skipped cheaply.
 */
export interface Snapshot {
  /** A commit SHA, or "working tree" */
  readonly label: string;
  readonly paths: readonly string[];
  has(path: string): boolean;
  isDirectory(path: string): boolean;
  read(path: string): string | undefined;
  hash(path: string): string | undefined;
}

const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

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

abstract class BaseSnapshot implements Snapshot {
  abstract readonly label: string;
  abstract readonly paths: readonly string[];
  abstract has(path: string): boolean;
  abstract read(path: string): string | undefined;
  abstract hash(path: string): string | undefined;

  private directories: Set<string> | undefined;

  isDirectory(path: string) {
    if (!this.directories) {
      this.directories = new Set(['']);
      for (const file of this.paths) {
        let slash = file.lastIndexOf('/');
        while (slash > 0) {
          const dir = file.slice(0, slash);
          if (this.directories.has(dir)) break;
          this.directories.add(dir);
          slash = dir.lastIndexOf('/');
        }
      }
    }
    return this.directories.has(trimSlashes(path));
  }
}

/** Files committed at a revision, read from git's object store */
export class GitSnapshot extends BaseSnapshot {
  readonly label: string;
  readonly paths: readonly string[];
  private readonly blobs = new Map<string, string>();
  private readonly contents = new Map<string, string>();
  private readonly repoRoot: string;

  constructor(repoRoot: string, commit: string) {
    super();
    this.repoRoot = repoRoot;
    this.label = commit;
    const listing = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]);
    for (const entry of listing.split('\0')) {
      if (!entry) continue;
      // "<mode> <type> <object>\t<path>"; submodules are commits, not files
      const tab = entry.indexOf('\t');
      const [, type, object] = entry.slice(0, tab).split(' ');
      if (type === 'blob') this.blobs.set(entry.slice(tab + 1), object);
    }
    this.paths = [...this.blobs.keys()];
  }

  has(path: string) {
    return this.blobs.has(path);
  }

  hash(path: string) {
    return this.blobs.get(path);
  }

  read(path: string) {
    const blob = this.blobs.get(path);
    if (!blob) return undefined;
    let content = this.contents.get(blob);
    if (content === undefined) {
      content = git(this.repoRoot, ['cat-file', 'blob', blob]);
      this.contents.set(blob, content);
    }
    return content;
  }
}

/** Files in the working tree that git tracks or would track, including uncommitted changes */
export class WorktreeSnapshot extends BaseSnapshot {
  readonly label = 'working tree';
  readonly paths: readonly string[];
  private readonly present: Set<string>;
  private readonly hashes = new Map<string, string>();
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    super();
    this.repoRoot = repoRoot;
    const listing = git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = new Set<string>();
    for (const path of listing.split('\0')) {
      // Tracked files deleted from the working tree are still listed
      if (path && isFileOrLink(join(repoRoot, path))) {
        paths.add(path);
      }
    }
    this.present = paths;
    this.paths = [...paths];
  }

  has(path: string) {
    return this.present.has(path);
  }

  read(path: string) {
    if (!this.present.has(path)) return undefined;
    return readRaw(join(this.repoRoot, path)).toString('utf8');
  }

  hash(path: string) {
    if (!this.present.has(path)) return undefined;
    let hash = this.hashes.get(path);
    if (!hash) {
      hash = gitBlobId(readRaw(join(this.repoRoot, path)));
      this.hashes.set(path, hash);
    }
    return hash;
  }
}

function isFileOrLink(path: string) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A file's content as git stores it: a symbolic link is its target path, never the file it
 * points to, so the working tree reads like a commit and a link can't pull in files from
 * outside the repository
 */
function readRaw(path: string) {
  return lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
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
