import ts from 'typescript';
/** Something an item uses */
export type Ref = 
/** A top-level name of this module, or an import binding */
{
    kind: 'name';
    name: string;
}
/** `object.property`, which is precise when `object` is a namespace import */
 | {
    kind: 'member';
    object: string;
    property: string;
}
/** `require("x")` or `import("x")`: the whole module, loaded when this item runs */
 | {
    kind: 'module';
    specifier: string;
};
export interface Item {
    /** The declared name, "default", or "#<content hash>" for a statement that declares nothing */
    key: string;
    names: string[];
    eager: boolean;
    /** The item's runtime code as normalized tokens; equal code means equal behaviour */
    code: string;
    refs: Ref[];
    /** Path expressions passed to file reads and Pulumi file assets/archives */
    assets: ts.Expression[];
    /**
     * Calls whose callee is a plain or member name, with their first argument: a call to any
     * function of an imported file-system module reads a path (resolved once imports are known)
     */
    calls: {
        object?: string;
        name: string;
        argument: ts.Expression;
    }[];
    /**
     * Values that look like paths: path-like properties (`context`, `dir`, …) and "./" or "../"
     * strings. They count as inputs when they name something in the repository.
     */
    pathCandidates: PathCandidate[];
    /** `require.resolve(...)` arguments: a path relative to the module, or a package */
    resolved: ts.Expression[];
    /** Other declarations of the same name (`var x` twice): using one uses all */
    siblings: Item[];
    /** A function declaration, which is hoisted, so where it sits doesn't matter */
    hoisted: boolean;
    /** `new StackReference(...)`: the referenced stack's name, and the outputs read from it */
    stackReferences: StackReferenceUse[];
    /** Why this item can't be analysed precisely, e.g. a `require` with a computed path */
    unanalysable: string[];
}
export interface StackReferenceUse {
    name: ts.Expression;
    /** Its position among the module's `new StackReference(...)` expressions, in source order */
    ordinal: number;
    /** How many there are in the module */
    total: number;
    /** Expressions naming the outputs read, or "all" when the reference is used in other ways */
    outputs: ts.Expression[] | 'all';
}
export interface PathCandidate {
    expression: ts.Expression;
    /** The property it's the value of, if any: `context`, `dir`, … */
    property?: string;
}
export interface ImportBinding {
    specifier: string;
    /** The exported name, "default", or "*" for a namespace import */
    imported: string;
}
export type ExportTarget = {
    kind: 'local';
    local: string;
} | {
    kind: 'reexport';
    specifier: string;
    imported: string;
};
export interface ModuleInfo {
    path: string;
    /**
     * CommonJS modules (`module.exports`, top-level `require`) can't be split into items reliably,
     * so all their items count as eager and importing anything from them means the whole module.
     */
    opaque: boolean;
    imports: Map<string, ImportBinding>;
    /** Specifiers of modules loaded when this module loads (static imports and re-exports) */
    loads: string[];
    exports: Map<string, ExportTarget>;
    starExports: string[];
    items: Item[];
    /** Top-level names (declared or imported) to the item declaring them */
    itemsByName: Map<string, Item>;
    /** The transpiled source; kept for evaluating constants */
    source: ts.SourceFile;
    /**
     * The module's top-level sequence: "load <specifier>" for each import, then item keys, in source
     * order. Import order and declaration order both change what runs first.
     */
    order: string[];
}
export declare function parseModule(path: string, text: string, options: ts.CompilerOptions): ModuleInfo;
/** True for expressions that run no code of their own when evaluated */
export declare function isPure(node: ts.Expression): boolean;
export declare function stringValue(node: ts.Node): string | undefined;
/**
 * Reduces code to its tokens, so formatting differences between the base and head
 * transpilations (the emitter keeps some of the original line breaks) don't count as changes.
 * Tokens come from the parsed tree, so template literals and regular expressions stay whole.
 */
export declare function normalizeCode(node: ts.Node): string;
