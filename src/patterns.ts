import picomatch from 'picomatch';

/** A stack as patterns see it: by project name and by project folder ("" is the repo root) */
export interface StackName {
  project: string;
  dir: string;
  stack: string;
}

export const ALL = 'all';

/**
 * Stack patterns are "<project>/<stack>", where <project> is the project's name or folder, or a
 * bare "<stack>" for that stack in every project. Both parts may be globs. "all" and "*" match
 * every stack.
 */
export function matchesStack(pattern: string, name: StackName) {
  const trimmed = pattern.trim();
  if (trimmed === ALL || trimmed === '*') return true;
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) return glob(trimmed)(name.stack);
  const projectPattern = trimmed.slice(0, slash);
  const stackPattern = trimmed.slice(slash + 1);
  if (!glob(stackPattern)(name.stack)) return false;
  const matchProject = glob(projectPattern);
  return matchProject(name.project) || matchProject(name.dir === '' ? '.' : name.dir);
}

export function matchesAnyStack(patterns: readonly string[], name: StackName) {
  return patterns.some((pattern) => matchesStack(pattern, name));
}

const globCache = new Map<string, (value: string) => boolean>();

/** Matches repo-relative paths (or names) against a glob; dotfiles match like any other file */
export function glob(pattern: string) {
  let matcher = globCache.get(pattern);
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true });
    globCache.set(pattern, matcher);
  }
  return matcher;
}

export function matchesAnyGlob(patterns: readonly string[], path: string) {
  return patterns.some((pattern) => glob(pattern)(path));
}

/** Splits a list written by hand ("dns, accounts/*" or one per line) into patterns */
export function splitPatterns(text: string) {
  return text
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}
