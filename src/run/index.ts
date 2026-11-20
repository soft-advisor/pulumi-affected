import { type Config, loadConfig } from '../config.ts';
import type { DependencyGraph } from '../graph.ts';
import { discoverProjects } from '../projects.ts';
import { type Request, type SelectResult, select } from '../select.ts';
import { GitSnapshot, git, repoRootOf, resolveCommit } from '../snapshot.ts';
import { commandRunner, lastDeployedCommit } from './pulumi.ts';
import { mapConcurrently, type Mode, runStacks, type StackRun } from './runner.ts';

export interface RunCommandOptions {
  cwd: string;
  mode: Mode;
  base: string;
  /** The revision to analyse; default HEAD */
  head?: string;
  run?: string[];
  skip?: string[];
  all?: boolean;
  messages?: string[];
  requests?: Request[];
  config?: Config;
  /** Overrides `run.command` in the config */
  command?: string;
  concurrency?: number;
  failFast?: boolean;
  onFinish?: (run: StackRun) => void;
  onWarning?: (message: string) => void;
}

export interface RunCommandResult {
  selection: SelectResult;
  runs: StackRun[];
}

/**
 * Selects stacks and previews or deploys them. Deploys compare each stack with the commit it
 * was last deployed from, so a stack whose deploy failed, or that was never deployed, runs again.
 */
export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const repoRoot = repoRootOf(options.cwd);
  // The committed revision, not the working tree: Pulumi itself edits stack config files (it
  // writes encryption salts), and that mustn't count as a change on the next run
  const headRevision = options.head ?? 'HEAD';
  const head = new GitSnapshot(repoRoot, resolveCommit(repoRoot, headRevision));
  const config = options.config ?? loadConfig(head);
  const runner = commandRunner(options.command || config.run.command, repoRoot);
  const concurrency = options.concurrency ?? config.run.concurrency;
  const allStacks = discoverProjects(head, config).flatMap((project) => project.stacks);

  let bases: Record<string, string | null> | undefined;
  if (options.mode === 'up') {
    bases = {};
    const commits = await mapConcurrently(allStacks, concurrency, (stack) =>
      lastDeployedCommit(runner, stack),
    );
    allStacks.forEach((stack, index) => {
      const commit = commits[index];
      if (commit === null) (bases as Record<string, string | null>)[stack.id] = null;
      else if (commit && ensureCommit(repoRoot, commit)) {
        (bases as Record<string, string | null>)[stack.id] = commit;
      } else if (commit) {
        options.onWarning?.(
          `${stack.id} was last deployed from ${commit}, which isn't in this checkout; comparing with ${options.base} instead`,
        );
      }
    });
  }

  const selection = select({
    cwd: options.cwd,
    base: options.base,
    head: headRevision,
    bases,
    run: options.run,
    skip: options.skip,
    all: options.all,
    messages: options.messages,
    requests: options.requests,
    config,
  });
  const graph: DependencyGraph = new Map(
    Object.entries(selection.dependencies).map(([id, dependencies]) => [id, new Set(dependencies)]),
  );
  const runs = await runStacks({
    mode: options.mode,
    stacks: selection.stacks.map((stack) => ({ stack, reasons: [...stack.reasons] })),
    allStacks,
    graph,
    runner,
    repoRoot,
    ignore: config.classify.ignore,
    concurrency,
    failFast: options.failFast ?? config.run.failFast,
    onFinish: options.onFinish,
  });
  return { selection, runs };
}

/** True when the commit is available locally, fetching it if needed */
function ensureCommit(repoRoot: string, sha: string) {
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
