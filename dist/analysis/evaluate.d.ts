import ts from 'typescript';
import type { ModuleInfo } from './module.ts';
export declare function moduleDir(module: ModuleInfo): string;
/** Where a path evaluated from code is anchored, and the rest of it */
export declare function anchorOf(value: string): {
    anchor: 'module';
    dir: string;
    rest: string;
} | {
    anchor: 'cwd';
    rest: string;
} | {
    anchor: 'none';
    rest: string;
};
/** Stands for the program's working directory: the project folder */
export declare const WORKING_DIR = "\0cwd";
/** Unknown parts of a stack name; stack names can't contain "*" */
export declare const WILDCARD = "*";
export interface EvaluationContext {
    /** Finds the declaration a name refers to, following imports */
    lookup(module: ModuleInfo, name: string): {
        module: ModuleInfo;
        node: ts.Expression;
    } | undefined;
    stack?: string;
    project?: string;
    /** Reads a stack config value as a string, e.g. ("my-project", "accounts") */
    config?(namespace: string, key: string): string | undefined;
    /** What unknown parts evaluate to; undefined makes the whole result unknown */
    unknown: typeof WILDCARD | undefined;
}
export declare function evaluateString(node: ts.Expression, module: ModuleInfo, context: EvaluationContext, depth?: number): string | undefined;
