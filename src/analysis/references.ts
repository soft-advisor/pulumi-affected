import ts from 'typescript';

/*
 * Which outputs a program reads from a stack reference, followed across the whole program with
 * the TypeScript language service and type checker: through exports and imports, aliases,
 * functions the reference is passed to, and helpers that take the output name as a parameter.
 * Output names must be provably constant: literals, templates and concatenations of them,
 * constants holding them, or a helper's parameter when every call of the helper passes one.
 * Types are never trusted for names, since a cast or `any` can make them say anything.
 *
 * Imports resolve exactly as the rest of the analysis resolves them. A module loaded with
 * `require()` or `import()` can't be followed this way, so references exported from one make
 * every output count as read. The per-module analysis handles the common, local cases; this
 * runs only where it gives up, within a time budget. Anything it can't follow means every
 * output may be read.
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
/** Time for one program's analysis before every unresolved reference counts as reading all */
const BUDGET_MS = 10_000;
/** Most names a template or condition may expand to */
const MAX_NAMES = 64;

class OutOfTime extends Error {}

/** Resolves an import the way the rest of the analysis does: to a repository path, or not */
export type ResolveFile = (specifier: string, from: string) => string | undefined;

export class ProgramReferences {
  private readonly service: ts.LanguageService;
  private readonly files: Map<string, string>;
  private program: ts.Program | undefined;
  /** The entry module, whose exports become stack outputs */
  private readonly entry: string | undefined;
  private readonly resolveFile: ResolveFile;
  private deadline = Number.POSITIVE_INFINITY;
  /** Files loaded with require() or import(); "all" when one of those can't be resolved */
  private dynamicLoads: Set<string> | 'all' | undefined;

  /** `files`: repository path → source, for every module of the program */
  constructor(files: Map<string, string>, entry: string | undefined, resolveFile: ResolveFile) {
    this.entry = entry === undefined ? undefined : `/${entry}`;
    this.resolveFile = resolveFile;
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
      resolveModuleNameLiterals: (literals, containingFile) =>
        literals.map((literal) => {
          const path = this.resolveFile(literal.text, containingFile.slice(1));
          const file = path === undefined ? undefined : `/${path}`;
          return {
            resolvedModule:
              file !== undefined && this.files.has(file)
                ? { resolvedFileName: file, extension: extensionOf(file) }
                : undefined,
          };
        }),
      getCancellationToken: () => ({
        isCancellationRequested: () => Date.now() > this.deadline,
        throwIfCancellationRequested: () => {
          if (Date.now() > this.deadline) throw new OutOfTime();
        },
      }),
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
    if (this.deadline === Number.POSITIVE_INFINITY) this.deadline = Date.now() + BUDGET_MS;
    try {
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
    } catch (error) {
      if (error instanceof OutOfTime || error instanceof ts.OperationCanceledException) {
        return 'all';
      }
      throw error;
    }
  }

  private checkTime() {
    if (Date.now() > this.deadline) throw new OutOfTime();
  }

  /** Whether a module's exports may be reached through require() or import() */
  private loadedDynamically(file: string) {
    if (this.dynamicLoads === undefined) {
      const loads = new Set<string>();
      let unknown = false;
      for (const source of this.program?.getSourceFiles() ?? []) {
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const dynamic =
              callee.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(callee) && callee.text === 'require');
            if (dynamic) {
              const argument = node.arguments[0];
              const resolved =
                argument && ts.isStringLiteralLike(argument)
                  ? this.resolveFile(argument.text, source.fileName.slice(1))
                  : undefined;
              if (resolved === undefined) {
                // A package, or a path that can't be worked out
                if (!argument || !ts.isStringLiteralLike(argument) || isRelative(argument.text)) {
                  unknown = true;
                }
              } else {
                loads.add(`/${resolved}`);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      this.dynamicLoads = unknown ? 'all' : loads;
    }
    return this.dynamicLoads === 'all' || this.dynamicLoads.has(file);
  }

  /** Follows where a stack reference value goes; false when it could be read in any way */
  private followValue(
    expression: ts.Expression,
    reads: Set<string>,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean {
    if (depth > MAX_DEPTH) return false;
    this.checkTime();
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
      if (exported && this.loadedDynamically(parent.getSourceFile().fileName)) return false;
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
      if (
        (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) &&
        (this.isEntry(node) || this.loadedDynamically(node.getSourceFile().fileName))
      ) {
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

  /** Adds the output names an expression can be; false when that can't be proven */
  private addNames(
    expression: ts.Expression,
    reads: Set<string>,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean {
    const names = this.constantNames(expression, depth, seen);
    if (!names) return false;
    for (const name of names) reads.add(name);
    return true;
  }

  /**
   * The strings an expression can evaluate to: literals, templates and concatenations of them,
   * conditions between them, constants holding them, and parameters every call passes them to
   */
  private constantNames(
    expression: ts.Expression,
    depth: number,
    seen: Set<ts.Node>,
  ): string[] | undefined {
    if (depth > MAX_DEPTH) return undefined;
    this.checkTime();
    if (ts.isParenthesizedExpression(expression)) {
      return this.constantNames(expression.expression, depth, seen);
    }
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isTemplateExpression(expression)) {
      let names = [expression.head.text];
      for (const span of expression.templateSpans) {
        const values = this.constantNames(span.expression, depth, seen);
        if (!values) return undefined;
        names = combine(names, values, span.literal.text);
        if (names.length > MAX_NAMES) return undefined;
      }
      return names;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.constantNames(expression.left, depth, seen);
      const right = left && this.constantNames(expression.right, depth, seen);
      if (!left || !right) return undefined;
      const names = combine(left, right, '');
      return names.length > MAX_NAMES ? undefined : names;
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = this.constantNames(expression.whenTrue, depth, seen);
      const whenFalse = whenTrue && this.constantNames(expression.whenFalse, depth, seen);
      return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])] : undefined;
    }
    if (!ts.isIdentifier(expression)) return undefined;
    let symbol = this.checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (!declaration) return undefined;
    // A constant holding a name
    if (ts.isVariableDeclaration(declaration)) {
      const isConst =
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst || !declaration.initializer || seen.has(declaration)) return undefined;
      seen.add(declaration);
      const names = this.constantNames(declaration.initializer, depth + 1, seen);
      seen.delete(declaration);
      return names;
    }
    // A parameter: the names are the arguments every call passes
    if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
    const fn = declaration.parent;
    if (usesArguments(fn)) return undefined;
    const index = fn.parameters.indexOf(declaration);
    const calls = this.callsOf(fn);
    if (!calls || calls.length === 0) return undefined;
    const names = new Set<string>();
    for (const call of calls) {
      const argument = call.arguments[index] ?? declaration.initializer;
      const values = argument && this.constantNames(argument, depth + 1, seen);
      if (!values) return undefined;
      for (const value of values) names.add(value);
    }
    return [...names];
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
    let declaration = this.checker.getResolvedSignature(call)?.declaration;
    if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
    // An overload has no body; the implementation's parameter is the one that's used
    if (!('body' in declaration) || !declaration.body) {
      let symbol = this.checker.getSymbolAtLocation(call.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = this.checker.getAliasedSymbol(symbol);
      }
      const implementation = symbol?.declarations?.find(
        (candidate): candidate is ts.FunctionLikeDeclaration =>
          ts.isFunctionLike(candidate) && 'body' in candidate && candidate.body !== undefined,
      );
      if (!implementation) return undefined;
      declaration = implementation;
    }
    if (usesArguments(declaration)) return undefined;
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

const EXTENSIONS: [string, ts.Extension][] = [
  ['.d.ts', ts.Extension.Dts],
  ['.d.mts', ts.Extension.Dmts],
  ['.d.cts', ts.Extension.Dcts],
  ['.tsx', ts.Extension.Tsx],
  ['.mts', ts.Extension.Mts],
  ['.cts', ts.Extension.Cts],
  ['.ts', ts.Extension.Ts],
  ['.jsx', ts.Extension.Jsx],
  ['.mjs', ts.Extension.Mjs],
  ['.cjs', ts.Extension.Cjs],
  ['.json', ts.Extension.Json],
];

function extensionOf(file: string) {
  return EXTENSIONS.find(([suffix]) => file.endsWith(suffix))?.[1] ?? ts.Extension.Js;
}

function combine(prefixes: string[], values: string[], suffix: string) {
  return prefixes.flatMap((prefix) => values.map((value) => `${prefix}${value}${suffix}`));
}

function isRelative(specifier: string) {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#');
}

/** Whether a function reads its arguments without naming them */
function usesArguments(fn: ts.SignatureDeclaration) {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === 'arguments') found = true;
    // A nested ordinary function has its own `arguments`
    else if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node)) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(fn, visit);
  return found;
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
