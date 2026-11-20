/** Stack id → ids of the stacks it depends on (reads outputs of, or otherwise needs first) */
export type DependencyGraph = Map<string, Set<string>>;

export class CycleError extends Error {}

export function addEdge(graph: DependencyGraph, from: string, to: string) {
  if (from === to) return;
  const dependencies = graph.get(from) ?? new Set();
  dependencies.add(to);
  graph.set(from, dependencies);
}

/**
 * Orders selected stacks into waves: a stack runs after every selected stack it depends on,
 * directly or through stacks that weren't selected. Stacks in the same wave are independent.
 */
export function computeWaves(graph: DependencyGraph, selected: readonly string[]) {
  const isSelected = new Set(selected);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  /** How many selected stacks lie on the longest dependency chain above `id` */
  const selectedAbove = (id: string, path: string[]): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' → ');
      throw new CycleError(`Stacks depend on each other in a cycle: ${cycle}`);
    }
    visiting.add(id);
    let result = 0;
    for (const dependency of graph.get(id) ?? []) {
      const above = selectedAbove(dependency, [...path, id]);
      result = Math.max(result, above + (isSelected.has(dependency) ? 1 : 0));
    }
    visiting.delete(id);
    depth.set(id, result);
    return result;
  };

  const waves: string[][] = [];
  for (const id of [...selected].sort()) {
    const wave = selectedAbove(id, []);
    while (waves.length <= wave) waves.push([]);
    waves[wave].push(id);
  }
  return waves.filter((wave) => wave.length > 0);
}

/** Stacks that depend on `id`; with `transitive`, also the stacks that depend on those */
export function dependentsOf(graph: DependencyGraph, id: string, transitive = false) {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const [stack, dependencies] of graph) {
      if (!dependencies.has(current) || result.has(stack) || stack === id) continue;
      result.add(stack);
      if (transitive) queue.push(stack);
    }
  }
  return [...result].sort();
}
