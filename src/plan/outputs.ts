import type { DeclaredOutputs, OutputsRead } from '../select.ts';

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
  /** Whether these outputs' new values are only known once applied: they may not change */
  maybe?: boolean;
}

export function staleReads(
  planned: readonly { id: string; outputs: string[]; unknownOutputs?: string[] }[],
  dependencies: Record<string, readonly string[]>,
  outputsRead: OutputsRead,
): StaleRead[] {
  const changed = new Map(
    planned.filter((stack) => stack.outputs.length > 0).map((stack) => [stack.id, stack]),
  );
  const stale: StaleRead[] = [];
  for (const [id, stackDependencies] of Object.entries(dependencies)) {
    for (const dependency of stackDependencies) {
      const plan = changed.get(dependency);
      if (!plan) continue;
      const outputs = plan.outputs;
      const reads = outputsRead[id]?.[dependency] ?? 'all';
      const read = reads === 'all' ? outputs : outputs.filter((output) => reads.includes(output));
      if (read.length === 0) continue;
      const maybe = read.every((output) => plan.unknownOutputs?.includes(output));
      stale.push({
        id,
        dependency,
        outputs: read,
        certain: reads !== 'all',
        ...(maybe ? { maybe } : {}),
      });
    }
  }
  return stale.sort((a, b) => a.id.localeCompare(b.id) || a.dependency.localeCompare(b.dependency));
}

/** "`site/dev` outputs `pageLength`, `url`" style text for reports */
export function describeRead(read: StaleRead) {
  const outputs = read.outputs.map((output) => `\`${output}\``).join(', ');
  const change = read.maybe
    ? 'which this change may alter (their new values are only known once applied)'
    : 'which this change alters';
  return read.certain
    ? `reads ${outputs} from \`${read.dependency}\`, ${change}`
    : `may read ${outputs} from \`${read.dependency}\` (which outputs it reads can't be worked out), ${change}`;
}

/**
 * Outputs dependsOn names that a stack doesn't export: a typo, or an output since renamed, which
 * would never change and so never bring the dependent along
 */
export function missingDeclaredOutputs(
  dependency: string,
  exported: Iterable<string>,
  declared: DeclaredOutputs,
) {
  const available = new Set(exported);
  const warnings: string[] = [];
  for (const [dependent, outputs] of Object.entries(declared[dependency] ?? {})) {
    const missing = outputs.filter((output) => !available.has(output));
    if (missing.length === 0) continue;
    warnings.push(
      `pulumi-affected.yaml: dependsOn says ${dependent} reads ${missing.map((output) => `"${output}"`).join(', ')} of ${dependency}, which it doesn't export${available.size > 0 ? ` (it exports ${[...available].sort().join(', ')})` : ''}`,
    );
  }
  return warnings;
}
