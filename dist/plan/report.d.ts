import type { ApplyResult } from './apply.ts';
import type { Manifest } from './manifest.ts';
export declare function renderPlan(manifest: Manifest, marker: (index: number) => string): {
    summary: string;
    bodies: string[];
};
export declare function renderApply(result: ApplyResult, marker: (index: number) => string): {
    summary: string;
    bodies: string[];
};
