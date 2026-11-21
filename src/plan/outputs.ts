import type { OutputsRead } from '../select.ts';

/*
 * Stacks that read outputs a plan changes. A stack's plan is made with the outputs its
 * dependencies have when it's planned, so once a planned change to those outputs is applied, the
 * stacks reading them need planning again. Which outputs a stack reads comes from its code; when
 * that can't be worked out, it's assumed to read every output.
 */

export interface StaleRead {
  /** The stack reading the outputs */
  id: string;
  /** The planned stack whose outputs change */
  dependency: string;
  /** The changed outputs it reads (all the changed ones when that isn't known) */
  outputs: string[];
  /** Whether the code shows it reads these outputs, rather than it being assumed */
  certain: boolean;
}

export function staleReads(
  planned: readonly { id: string; outputs: string[] }[],
  dependencies: Record<string, readonly string[]>,
  outputsRead: OutputsRead,
): StaleRead[] {
  const changed = new Map(
    planned.filter((stack) => stack.outputs.length > 0).map((stack) => [stack.id, stack.outputs]),
  );
  const stale: StaleRead[] = [];
  for (const [id, stackDependencies] of Object.entries(dependencies)) {
    for (const dependency of stackDependencies) {
      const outputs = changed.get(dependency);
      if (!outputs) continue;
      const reads = outputsRead[id]?.[dependency] ?? 'all';
      const read = reads === 'all' ? outputs : outputs.filter((output) => reads.includes(output));
      if (read.length > 0) stale.push({ id, dependency, outputs: read, certain: reads !== 'all' });
    }
  }
  return stale.sort((a, b) => a.id.localeCompare(b.id) || a.dependency.localeCompare(b.dependency));
}

/** "`site/dev` outputs `pageLength`, `url`" style text for reports */
export function describeRead(read: StaleRead) {
  const outputs = read.outputs.map((output) => `\`${output}\``).join(', ');
  return read.certain
    ? `reads ${outputs} from \`${read.dependency}\`, which this change alters`
    : `may read ${outputs} from \`${read.dependency}\` (which outputs it reads can't be worked out), which this change alters`;
}
