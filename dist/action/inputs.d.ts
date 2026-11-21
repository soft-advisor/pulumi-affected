import type { SelectOptions } from '../select.ts';
import { type GitHubEvent } from './github.ts';
/** Selection options from the action's inputs and the triggering event, shared by select and plan */
export declare function selectOptionsFromInputs(): {
    options: SelectOptions;
    event: GitHubEvent;
};
/** The pull request a run belongs to: the input, else the triggering pull request */
export declare function pullRequestNumber(event: GitHubEvent): number | undefined;
export declare function positiveInteger(name: string, fallback: number): number;
