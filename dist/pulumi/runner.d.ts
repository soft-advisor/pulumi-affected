/** What the runner needs of a stack */
export interface StackTarget {
    id: string;
    project: string;
    dir: string;
    stack: string;
}
export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export interface PulumiRunner {
    /** Runs `<command template for the stack> <args>` */
    run(stack: StackTarget, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult>;
    /** Runs `pulumi <args>` directly, for work in a temporary backend */
    runPulumi(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
}
export declare const DEFAULT_COMMAND = "pulumi --cwd {dir} --stack {stack}";
export declare function childEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** The template's words with placeholders filled in, each value staying one argument */
export declare function expandTemplate(template: string, stack: StackTarget): string[];
/** Runs `cleanup` on cancellation too; returns a function that unregisters it */
export declare function onCancel(cleanup: () => void): () => boolean;
export declare function commandRunner(template: string, repoRoot: string): PulumiRunner;
export declare function isMissingStack(result: CommandResult): boolean;
/**
 * The useful part of a failed command's output, without the resource values the JSON output
 * carries: Pulumi's error diagnostics, else error lines and the last lines of stderr and of any
 * non-JSON output.
 */
export declare function errorText(result: CommandResult): string;
/** The last top-level JSON object in output, after anything a wrapper printed */
export declare function parseLastJsonObject(text: string): unknown;
/** The JSON array in output that a wrapper script may have printed other lines around */
export declare function parseJsonArray<T>(text: string): T[] | undefined;
