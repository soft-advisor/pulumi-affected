import ts from 'typescript';

/*
 * Which outputs a program reads from a stack reference, followed across the whole program with
 * the TypeScript language service and type checker: through exports and imports, aliases,
 * functions the reference is passed to, and helpers that take the output name as a parameter.
 * Output names come from string literal types, so a parameter typed `'vpcId' | 'subnets'`
 * names both, and from the arguments at each call of a helper.
 *
 * The per-module analysis handles the common, local cases; this runs only where it gives up.
 * Anything this can't follow either means every output may be read.
 */

/** StackReference methods that read one output, named by their first argument */
const OUTPUT_READERS = new Set([
  'getOutput',
  'requireOutput',
  'getOutputValue',
  'requireOutputValue',
  'getOutputDetails',
]);

const MAX_DEPTH = 6;

export class ProgramReferences {
  private readonly service: ts.LanguageService;
  private readonly files: Map<string, string>;
  private program: ts.Program | undefined;
  /** The entry module, whose exports become stack outputs */
  private readonly entry: string | undefined;

  /** `files`: repository path → source, for every module of the program */
  constructor(files: Map<string, string>, entry?: string) {
    this.entry = entry === undefined ? undefined : `/${entry}`;
    this.files = new Map([...files].map(([path, text]) => [`/${path}`, text]));
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      noLib: true,
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      noEmit: true,
    };
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: () => '1',
      getScriptSnapshot: (name) => {
        const text = this.files.get(name);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => '/lib.d.ts',
      fileExists: (name) => this.files.has(name),
      readFile: (name) => this.files.get(name),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private get checker() {
    this.program ??= this.service.getProgram();
    return (this.program as ts.Program).getTypeChecker();
  }

  /**
   * The outputs read from the `ordinal`-th of the `total` `new StackReference(...)` expressions
   * in the file at `path` (counted in source order, which compiling keeps), or "all"
   */
  outputsRead(path: string, ordinal: number, total: number): string[] | 'all' {
    this.program ??= this.service.getProgram();
    const source = this.program?.getSourceFile(`/${path}`);
    if (!source) return 'all';
    const found = stackReferences(source);
    if (found.length !== total) return 'all';
    const node = found[ordinal];
    if (!node) return 'all';
    const reads = new Set<string>();
    const ok = this.followValue(node, reads, 0, new Set());
    return ok ? [...reads].sort() : 'all';
  }

  /** Follows where a stack reference value goes; false when it could be read in any way */
  private followValue(
    expression: ts.Expression,
    reads: Set<string>,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean {
    if (depth > MAX_DEPTH) return false;
    let value: ts.Expression = expression;
    while (
      ts.isParenthesizedExpression(value.parent) ||
      ts.isAsExpression(value.parent) ||
      ts.isNonNullExpression(value.parent) ||
      ts.isSatisfiesExpression(value.parent)
    ) {
      value = value.parent as ts.Expression;
    }
    const parent = value.parent;

    // Kept in a constant or variable: follow every use of it, across files
    if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
      if (!ts.isIdentifier(parent.name)) return false;
      const statement = parent.parent.parent;
      const exported =
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      // The entry module's exports are the stack's outputs, which include the reference's
      if (exported && this.isEntry(parent)) return false;
      return this.followBinding(parent.name, reads, depth, seen);
    }
    if (ts.isExportAssignment(parent)) return false;
    // Passed to a function: follow the parameter inside it
    if (ts.isCallExpression(parent) && parent.arguments.includes(value)) {
      const parameter = this.parameterFor(parent, parent.arguments.indexOf(value));
      return parameter !== undefined && this.followBinding(parameter, reads, depth + 1, seen);
    }
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== value) return false;

    const member = parent.name.text;
    if (OUTPUT_READERS.has(member)) {
      const call = parent.parent;
      if (!ts.isCallExpression(call) || call.expression !== parent || !call.arguments[0]) {
        return false;
      }
      return this.addNames(call.arguments[0], reads, depth, seen);
    }
    if (member === 'outputs') {
      const access = parent.parent;
      if (ts.isPropertyAccessExpression(access) && access.expression === parent) {
        reads.add(access.name.text);
        return true;
      }
      if (ts.isElementAccessExpression(access) && access.expression === parent) {
        return this.addNames(access.argumentExpression, reads, depth, seen);
      }
    }
    return false;
  }

  /** Follows every use of a name bound to a stack reference: in this file and importers */
  private followBinding(
    name: ts.Identifier,
    reads: Set<string>,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean {
    if (seen.has(name)) return true;
    seen.add(name);
    const references = this.referencesTo(name);
    if (references === undefined) return false;
    for (const reference of references) {
      const node = reference;
      const parent = node.parent;
      // Imports and exports only pass the name on; its uses are among the references too
      if ((ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) && this.isEntry(node)) {
        return false;
      }
      if (
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isExportAssignment(parent)
      ) {
        continue;
      }
      // `refs.network` through a namespace import is the value
      const value =
        ts.isPropertyAccessExpression(parent) && parent.name === node
          ? parent
          : (node as ts.Expression);
      if (!this.followValue(value, reads, depth, seen)) return false;
    }
    return true;
  }

  private isEntry(node: ts.Node) {
    // Without a known entry, any module's exports might be the stack's outputs
    return this.entry === undefined || node.getSourceFile().fileName === this.entry;
  }

  /** The output names an expression can be: string literal types, or a helper's call arguments */
  private addNames(
    expression: ts.Expression,
    reads: Set<string>,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean {
    if (depth > MAX_DEPTH) return false;
    const literals = literalStrings(this.checker.getTypeAtLocation(expression));
    if (literals) {
      for (const literal of literals) reads.add(literal);
      return true;
    }
    // A parameter: the names are the arguments every call passes
    if (!ts.isIdentifier(expression)) return false;
    const declaration = this.checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) {
      return false;
    }
    const fn = declaration.parent;
    const index = fn.parameters.indexOf(declaration);
    const calls = this.callsOf(fn);
    if (!calls || calls.length === 0) return false;
    for (const call of calls) {
      const argument = call.arguments[index];
      if (!argument) {
        const initializer = declaration.initializer;
        if (!initializer || !this.addNames(initializer, reads, depth + 1, seen)) return false;
        continue;
      }
      if (!this.addNames(argument, reads, depth + 1, seen)) return false;
    }
    return true;
  }

  /** Every call of a function; undefined when it's also used other ways (passed, exported) */
  private callsOf(fn: ts.SignatureDeclaration): ts.CallExpression[] | undefined {
    const name = functionName(fn);
    if (!name) return undefined;
    const references = this.referencesTo(name);
    if (!references) return undefined;
    const calls: ts.CallExpression[] = [];
    for (const reference of references) {
      const parent = reference.parent;
      if (
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent)
      ) {
        continue;
      }
      const callee =
        ts.isPropertyAccessExpression(parent) && parent.name === reference ? parent : reference;
      const call = callee.parent;
      if (ts.isCallExpression(call) && call.expression === callee) calls.push(call);
      else return undefined;
    }
    return calls;
  }

  /** The parameter a call's argument lands in, when the callee is known */
  private parameterFor(call: ts.CallExpression, index: number) {
    const declaration = this.checker.getResolvedSignature(call)?.declaration;
    if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
    const parameter = declaration.parameters[index];
    if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))
      return undefined;
    return parameter.name;
  }

  /** Uses of a declared name across the program, without its declarations */
  private referencesTo(name: ts.Identifier): ts.Identifier[] | undefined {
    const file = name.getSourceFile().fileName;
    const found = this.service.findReferences(file, name.getStart());
    if (!found) return undefined;
    const nodes: ts.Identifier[] = [];
    for (const symbol of found) {
      for (const reference of symbol.references) {
        if (reference.isDefinition) continue;
        const source = this.program?.getSourceFile(reference.fileName);
        const node = source && findIdentifier(source, reference.textSpan.start);
        if (!node) return undefined;
        nodes.push(node);
      }
    }
    return nodes;
  }
}

/** `new StackReference(...)` expressions in source order */
export function stackReferences(source: ts.SourceFile) {
  const found: ts.NewExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === 'StackReference') found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function literalStrings(type: ts.Type): string[] | undefined {
  const types = type.isUnion() ? type.types : [type];
  const values: string[] = [];
  for (const member of types) {
    if (!member.isStringLiteral()) return undefined;
    values.push(member.value);
  }
  return values.length > 0 ? values : undefined;
}

function functionName(fn: ts.SignatureDeclaration): ts.Identifier | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return ts.isIdentifier(fn.name) ? fn.name : undefined;
  }
  const parent = fn.parent;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name;
  }
  return undefined;
}

function findIdentifier(source: ts.SourceFile, position: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (found || position < node.getFullStart() || position >= node.getEnd()) return;
    if (ts.isIdentifier(node) && node.getStart(source) === position) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
