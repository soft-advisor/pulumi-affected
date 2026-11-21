import { type Config, loadConfig } from '../config.ts';
import type { DependencyGraph } from '../graph.ts';
import { discoverProjects } from '../projects.ts';
import { type Request, type SelectResult, select } from '../select.ts';
import { ensureCommit, GitSnapshot, repoRootOf, resolveCommit } from '../snapshot.ts';
import { commandRunner, deployHistory } from './pulumi.ts';
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
  /** Let Pulumi request GitHub OIDC tokens; see RunnerOptions */
  passOidc?: boolean;
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
  const runner = commandRunner(options.command || config.run.command, repoRoot, {
    passOidc: options.passOidc,
  });
  const concurrency = options.concurrency ?? config.run.concurrency;
  const allStacks = discoverProjects(head, config).flatMap((project) => project.stacks);

  let bases: Record<string, string | null> | undefined;
  const reasons: Record<string, string> = {};
  if (options.mode === 'up') {
    bases = {};
    const histories = await mapConcurrently(allStacks, concurrency, (stack) =>
      deployHistory(runner, stack),
    );
    allStacks.forEach((stack, index) => {
      const history = histories[index];
      const stackBases = bases as Record<string, string | null>;
      if (history.kind === 'never') {
        stackBases[stack.id] = null;
      } else if (history.kind === 'unknown') {
        reasons[stack.id] = history.why;
      } else if (ensureCommit(repoRoot, history.sha)) {
        stackBases[stack.id] = history.sha;
        if (history.lastFailed) reasons[stack.id] = 'its last deploy failed';
        if (history.dirty && !history.lastFailed) {
          options.onWarning?.(
            `${stack.id} was last deployed from ${history.sha.slice(0, 7)} with uncommitted changes; anything never committed isn't compared`,
          );
        }
      } else {
        reasons[stack.id] = `its last deploy was from ${history.sha}, which isn't in this checkout`;
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
    reasons,
    trustedSkipsOnly: options.mode === 'up',
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
    newStacks: config.run.newStacks,
    createStacks: config.run.createStacks,
    onFinish: options.onFinish,
  });
  return { selection, runs };
}
