import ts from 'typescript';
/** Resolves an import the way the rest of the analysis does: to a repository path, or not */
export type ResolveFile = (specifier: string, from: string) => string | undefined;
export declare class ProgramReferences {
    private readonly service;
    private readonly files;
    private program;
    /** The entry module, whose exports become stack outputs */
    private readonly entry;
    private readonly resolveFile;
    private deadline;
    /** Files loaded with require() or import(); "all" when one of those can't be resolved */
    private dynamicLoads;
    /** `files`: repository path → source, for every module of the program */
    constructor(files: Map<string, string>, entry: string | undefined, resolveFile: ResolveFile);
    private get checker();
    /**
     * The outputs read from the `ordinal`-th of the `total` `new StackReference(...)` expressions
     * in the file at `path` (counted in source order, which compiling keeps), or "all"
     */
    outputsRead(path: string, ordinal: number, total: number): string[] | 'all';
    private checkTime;
    /** Whether a module's exports may be reached through require() or import() */
    private loadedDynamically;
    /** Follows where a stack reference value goes; false when it could be read in any way */
    private followValue;
    /** Follows every use of a name bound to a stack reference: in this file and importers */
    private followBinding;
    private isEntry;
    /** Adds the output names an expression can be; false when that can't be proven */
    private addNames;
    /**
     * The strings an expression can evaluate to: literals, templates and concatenations of them,
     * conditions between them, constants holding them, and parameters every call passes them to
     */
    private constantNames;
    /** Every call of a function; undefined when it's also used other ways (passed, exported) */
    private callsOf;
    /** The parameter a call's argument lands in, when the callee is known */
    private parameterFor;
    /** Uses of a declared name across the program, without its declarations */
    private referencesTo;
}
/** `new StackReference(...)` expressions in source order */
export declare function stackReferences(source: ts.SourceFile): ts.NewExpression[];
