import type { ApplyResult } from './apply.ts';
import type { Manifest } from './manifest.ts';
import type { OutputReaders, UpResult } from './up.ts';
export declare function renderPlan(manifest: Manifest, marker: (index: number) => string, outputReaders?: OutputReaders): {
    summary: string;
    bodies: string[];
};
export declare function renderApply(result: ApplyResult, marker: (index: number) => string): {
    summary: string;
    bodies: string[];
};
export declare function renderUp(result: UpResult, marker: (index: number) => string): {
    summary: string;
    bodies: string[];
};
