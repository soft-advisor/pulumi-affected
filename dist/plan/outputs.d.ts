import type { OutputsRead } from '../select.ts';
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
export declare function staleReads(planned: readonly {
    id: string;
    outputs: string[];
    unknownOutputs?: string[];
}[], dependencies: Record<string, readonly string[]>, outputsRead: OutputsRead): StaleRead[];
/** "`site/dev` outputs `pageLength`, `url`" style text for reports */
export declare function describeRead(read: StaleRead): string;
