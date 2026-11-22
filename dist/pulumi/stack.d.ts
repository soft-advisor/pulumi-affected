import { type PulumiRunner, type StackTarget } from './runner.ts';
export type StateFingerprint = {
    kind: 'exists';
    fingerprint: string;
    /** The passphrase secrets provider's salt, when the state records one */
    salt?: string;
} | {
    kind: 'missing';
};
export declare class StackError extends Error {
}
/** The fingerprint of a stack that holds nothing, as `stack init` leaves it */
export declare const EMPTY_FINGERPRINT: string;
export declare function stateFingerprint(runner: PulumiRunner, stack: StackTarget): Promise<StateFingerprint>;
interface HistoryEntry {
    kind?: string;
    result?: string;
    message?: string;
    /** Resources per operation, e.g. { create: 2, same: 5 } */
    resourceChanges?: Record<string, number>;
}
/** The stack's newest history entries, newest first */
export declare function recentUpdates(runner: PulumiRunner, stack: StackTarget, count?: number): Promise<HistoryEntry[]>;
/** Stack outputs including secrets, compared in memory only and never printed */
export declare function readOutputs(runner: PulumiRunner, stack: StackTarget): Promise<Record<string, unknown>>;
/** The secrets provider a stack's config file names, other than the passphrase default */
export declare function secretsProviderOf(config: string | undefined): string | undefined;
export {};
