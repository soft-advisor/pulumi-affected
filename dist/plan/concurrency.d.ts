/** Runs `task` on each item with at most `limit` running at once, keeping the input order */
export declare function mapConcurrently<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]>;
