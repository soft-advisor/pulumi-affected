/** Stack id → ids of the stacks it depends on (reads outputs of, or otherwise needs first) */
export type DependencyGraph = Map<string, Set<string>>;
export declare class CycleError extends Error {
}
export declare function addEdge(graph: DependencyGraph, from: string, to: string): void;
/**
 * Orders selected stacks into waves: a stack runs after every selected stack it depends on,
 * directly or through stacks that weren't selected. Stacks in the same wave are independent.
 */
export declare function computeWaves(graph: DependencyGraph, selected: readonly string[]): string[][];
/** Stacks that depend on `id`; with `transitive`, also the stacks that depend on those */
export declare function dependentsOf(graph: DependencyGraph, id: string, transitive?: boolean): string[];
