import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { type SelectOptions, select } from '../src/select.ts';

/** File contents by repo-relative path; null deletes the file */
export type Files = Record<string, string | null>;

const repos: string[] = [];
after(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

export function run(cwd: string, command: string, args: string[]) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A git repository with `files` committed as its first commit */
export function createRepo(files: Files) {
  const dir = mkdtempSync(join(tmpdir(), 'pulumi-affected-'));
  repos.push(dir);
  run(dir, 'git', ['init', '-q', '-b', 'main']);
  run(dir, 'git', ['config', 'user.email', 'test@example.com']);
  run(dir, 'git', ['config', 'user.name', 'Test']);
  run(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  const base = commit(dir, files, 'base');
  return { dir, base };
}

/** Writes `files` and commits them, returning the new commit's SHA */
export function commit(dir: string, files: Files, message = 'change') {
  write(dir, files);
  run(dir, 'git', ['add', '-A']);
  run(dir, 'git', ['commit', '-q', '--allow-empty', '-m', message]);
  return run(dir, 'git', ['rev-parse', 'HEAD']).trim();
}

export function write(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Commits `before`, then `after` on top, and selects between them */
export function selectChange(
  before: Files,
  changes: Files,
  options: Partial<SelectOptions> & { message?: string } = {},
) {
  const { dir, base } = createRepo(before);
  const head = commit(dir, changes, options.message);
  return select({ cwd: dir, base, head, ...options });
}

export function selectedIds(result: ReturnType<typeof select>) {
  return result.stacks.map((stack) => stack.id);
}

export function reasonsOf(result: ReturnType<typeof select>, id: string) {
  return result.stacks.find((stack) => stack.id === id)?.reasons ?? [];
}

/** A Node.js Pulumi project's files, rooted at `dir` */
export function project(dir: string, name: string, stacks: string[], files: Files = {}): Files {
  const prefix = dir === '' ? '' : `${dir}/`;
  const result: Files = { [`${prefix}Pulumi.yaml`]: `name: ${name}\nruntime: nodejs\n` };
  for (const stack of stacks) {
    result[`${prefix}Pulumi.${stack}.yaml`] = `config:\n  ${name}:region: eu-west-2\n`;
  }
  for (const [path, content] of Object.entries(files)) result[`${prefix}${path}`] = content;
  return result;
}
