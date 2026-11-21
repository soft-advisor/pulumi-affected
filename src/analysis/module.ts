import { createHash } from 'node:crypto';
import ts from 'typescript';
import { stackReferences } from './references.ts';

/*
 * A module is analysed as the JavaScript that actually runs: each file is transpiled the way
 * Pulumi's TypeScript support does it (types erased, unused imports elided, comments dropped),
 * and the output is split into top-level items. That makes type-only edits, comments and
 * formatting invisible without any special cases.
 *
 * Items are lazy or eager:
 * - Lazy items (function declarations, and constants whose initializer runs no code) only matter
 *   if something that runs references them.
 * - Eager items (any statement that runs code when the module loads) matter whenever the module
 *   is loaded, whether or not anything uses what they declare. In a Pulumi program that's where
 *   resources get created.
 */

/** Something an item uses */
export type Ref =
  /** A top-level name of this module, or an import binding */
  | { kind: 'name'; name: string }
  /** `object.property`, which is precise when `object` is a namespace import */
  | { kind: 'member'; object: string; property: string }
  /** `require("x")` or `import("x")`: the whole module, loaded when this item runs */
  | { kind: 'module'; specifier: string };

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
  calls: { object?: string; name: string; argument: ts.Expression }[];
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

export type ExportTarget =
  | { kind: 'local'; local: string }
  | { kind: 'reexport'; specifier: string; imported: string };

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

const ASSET_READERS = new Set([
  'readFileSync',
  'readFile',
  'createReadStream',
  'readdirSync',
  'readdir',
  'FileAsset',
  'FileArchive',
  'existsSync',
  'statSync',
  'lstatSync',
  'readJson',
  'readJsonSync',
  'globSync',
  'glob',
]);

/** Properties whose string value is usually a path: Docker build contexts, archive folders, … */
const PATH_PROPERTIES = new Set([
  'context',
  'dockerfile',
  'path',
  'dir',
  'directory',
  'location',
  'cwd',
  'source',
  'root',
  'file',
  'filename',
  'codePath',
]);

const RELATIVE_PATH = /^\.\.?\//;

/**
 * Names this module imports, while it's being parsed: reading a property of an imported
 * namespace (aws.ec2.InstanceType.T3_Micro) is treated as pure, like reading a constant
 */
let importedNames = new Set<string>();

export function parseModule(path: string, text: string, options: ts.CompilerOptions): ModuleInfo {
  if (path.endsWith('.json')) return parseJsonModule(path, text);

  const output = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: false,
    compilerOptions: {
      ...options,
      // Always the latest syntax, so constants stay `const` and nothing is downleveled; a
      // change of target is caught separately as a compiler options change
      target: ts.ScriptTarget.ESNext,
      // TypeScript's default follows the target, so keep what the configured target implies
      useDefineForClassFields:
        options.useDefineForClassFields ??
        (options.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2022,
      // ESM syntax stays as written, and `import x = require()` and `export =` become the
      // require() and module.exports they are at runtime
      module: ts.ModuleKind.Preserve,
      removeComments: true,
      sourceMap: false,
      inlineSourceMap: false,
      declaration: false,
      noEmit: false,
    },
  }).outputText;
  const source = ts.createSourceFile(
    `${path}.js`,
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const module: ModuleInfo = {
    path,
    opaque: isCommonJs(source),
    imports: new Map(),
    loads: [],
    exports: new Map(),
    starExports: [],
    items: [],
    itemsByName: new Map(),
    source,
    order: [],
  };
  const keys = new Map<string, number>();
  const addItem = (item: Item) => {
    if (module.opaque) item.eager = true;
    // `var x` declared twice is one variable: both declarations count wherever x is used
    const seen = (keys.get(item.key) ?? 0) + 1;
    keys.set(item.key, seen);
    if (seen > 1) item.key = `${item.key}.${seen}`;
    for (const name of item.names) {
      const earlier = module.itemsByName.get(name);
      if (earlier && earlier !== item) {
        earlier.siblings.push(item);
        item.siblings.push(earlier);
      }
      if (!earlier) module.itemsByName.set(name, item);
    }
    module.items.push(item);
    module.order.push(item.key);
  };

  importedNames = new Set();
  for (const statement of source.statements) {
    recordRequireBindings(module, statement);
    if (ts.isImportDeclaration(statement)) {
      const specifier = stringValue(statement.moduleSpecifier);
      if (specifier === undefined) continue;
      module.loads.push(specifier);
      module.order.push(`load ${specifier}`);
      const clause = statement.importClause;
      if (clause?.name) module.imports.set(clause.name.text, { specifier, imported: 'default' });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        module.imports.set(bindings.name.text, { specifier, imported: '*' });
      } else if (bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          module.imports.set(element.name.text, { specifier, imported });
        }
      }
      for (const name of module.imports.keys()) importedNames.add(name);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && stringValue(statement.moduleSpecifier);
      if (specifier !== undefined) {
        module.loads.push(specifier);
        module.order.push(`load ${specifier}`);
      }
      const clause = statement.exportClause;
      if (!clause) {
        if (specifier !== undefined) module.starExports.push(specifier);
      } else if (ts.isNamespaceExport(clause)) {
        if (specifier !== undefined) {
          module.exports.set(clause.name.text, { kind: 'reexport', specifier, imported: '*' });
        }
      } else {
        for (const element of clause.elements) {
          const exported = element.name.text;
          const source = (element.propertyName ?? element.name).text;
          module.exports.set(
            exported,
            specifier === undefined
              ? { kind: 'local', local: source }
              : { kind: 'reexport', specifier, imported: source },
          );
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression) && !statement.isExportEquals) {
        module.exports.set('default', { kind: 'local', local: statement.expression.text });
        continue;
      }
      module.exports.set('default', { kind: 'local', local: 'default' });
      addItem(makeItem('default', ['default'], !isPure(statement.expression), statement));
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      recordDeclarationExports(module, statement, [name]);
      const eager = ts.isClassDeclaration(statement) && !isPureClass(statement);
      const item = makeItem(name, [name], eager, statement);
      item.hoisted = ts.isFunctionDeclaration(statement);
      addItem(item);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const keyword = variableKeyword(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        const names = bindingNames(declaration.name);
        recordDeclarationExports(module, statement, names);
        const eager = declaration.initializer !== undefined && !isPure(declaration.initializer);
        const item = makeItem(names.join(','), names, eager, declaration, keyword);
        addItem(item);
      }
      continue;
    }

    if (statement.kind === ts.SyntaxKind.EmptyStatement) continue;
    // A TypeScript enum compiles to `var E; (function (E) { … })(E || (E = {}));`. The function
    // only fills in E, so it belongs to E's declaration and is as lazy as E is.
    const enumName = enumFillName(statement);
    const enumDeclaration = enumName === undefined ? undefined : module.itemsByName.get(enumName);
    if (enumDeclaration && !enumDeclaration.eager) {
      const fill = makeItem(enumName as string, [], false, statement);
      enumDeclaration.code += ` ${fill.code}`;
      enumDeclaration.refs.push(...fill.refs);
      continue;
    }
    // Keyed by content rather than position, so inserting a statement doesn't make every later
    // one look changed; the module's statement order is compared separately
    const item = makeItem('', [], true, statement);
    item.key = `#${createHash('sha256').update(item.code).digest('hex').slice(0, 10)}`;
    addItem(item);
  }
  importedNames = new Set();
  return module;
}

/**
 * `const fs = require('fs')`, `const { readFileSync } = require('node:fs')` and (after
 * transpiling) `import fs = require('fs')` bind names like imports do
 */
function recordRequireBindings(module: ModuleInfo, statement: ts.Statement) {
  if (!ts.isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer;
    if (!initializer || !ts.isCallExpression(initializer)) continue;
    const callee = initializer.expression;
    const specifier = initializer.arguments[0] && stringValue(initializer.arguments[0]);
    if (!ts.isIdentifier(callee) || callee.text !== 'require' || specifier === undefined) continue;
    if (ts.isIdentifier(declaration.name)) {
      module.imports.set(declaration.name.text, { specifier, imported: '*' });
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const imported =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        module.imports.set(element.name.text, { specifier, imported });
      }
    }
    for (const name of module.imports.keys()) importedNames.add(name);
  }
}

/** E, when the statement is TypeScript's enum fill `(function (E) { … })(E || (E = {}))` */
function enumFillName(statement: ts.Statement) {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const call = statement.expression;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return undefined;
  const fill = ts.isParenthesizedExpression(call.expression)
    ? call.expression.expression
    : call.expression;
  if (!ts.isFunctionExpression(fill) || fill.parameters.length !== 1) return undefined;
  const argument = call.arguments[0];
  if (
    !ts.isBinaryExpression(argument) ||
    argument.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  ) {
    return undefined;
  }
  return ts.isIdentifier(argument.left) ? argument.left.text : undefined;
}

function makeItem(key: string, names: string[], eager: boolean, node: ts.Node, prefix = ''): Item {
  const item: Item = {
    key,
    names,
    eager,
    code: `${prefix} ${normalizeCode(node)}`.trim(),
    refs: [],
    assets: [],
    calls: [],
    pathCandidates: [],
    resolved: [],
    siblings: [],
    hoisted: false,
    stackReferences: [],
    unanalysable: [],
  };
  collectRefs(node, item, new Set(names));
  return item;
}

function recordDeclarationExports(module: ModuleInfo, statement: ts.Statement, names: string[]) {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (!isExported) return;
  const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  if (isDefault) {
    module.exports.set('default', { kind: 'local', local: names[0] });
    return;
  }
  for (const name of names) module.exports.set(name, { kind: 'local', local: name });
}

/**
 * Collects what a node uses. Names a node declares for itself (its own name, parameters,
 * properties) aren't uses. Inner variables that shadow a top-level name are counted as uses of
 * it, which can only make the analysis select more, never less.
 */
function collectRefs(root: ts.Node, item: Item, ownNames: Set<string>) {
  const addName = (name: string) => {
    if (!ownNames.has(name)) item.refs.push({ kind: 'name', name });
  };

  const visitBindingName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) return;
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
        visit(element.propertyName);
      }
      visitBindingName(element.name);
      if (element.initializer) visit(element.initializer);
    }
  };

  const visitPropertyName = (name: ts.PropertyName | undefined) => {
    if (name && ts.isComputedPropertyName(name)) visit(name.expression);
  };

  const visitModifiers = (node: ts.Node) => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    for (const modifier of [...(modifiers ?? []), ...(decorators ?? [])]) visit(modifier);
  };

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) && RELATIVE_PATH.test(node.text) && !isModuleSpecifier(node)) {
      item.pathCandidates.push({ expression: node });
    }
    if (ts.isIdentifier(node)) {
      addName(node.text);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        item.refs.push({ kind: 'member', object: node.expression.text, property: node.name.text });
      } else {
        visit(node.expression);
      }
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const property = stringValue(node.argumentExpression);
      if (ts.isIdentifier(node.expression) && property !== undefined) {
        item.refs.push({ kind: 'member', object: node.expression.text, property });
        return;
      }
      visit(node.expression);
      visit(node.argumentExpression);
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      inspectCall(node, item);
    }
    if (ts.isPropertyAssignment(node)) {
      visitPropertyName(node.name);
      const property =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (PATH_PROPERTIES.has(property)) {
        item.pathCandidates.push({ expression: node.initializer, property });
      }
      visit(node.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      // `{ context }` is `{ context: context }`
      if (PATH_PROPERTIES.has(node.name.text)) {
        item.pathCandidates.push({ expression: node.name, property: node.name.text });
      }
      addName(node.name.text);
      if (node.objectAssignmentInitializer) visit(node.objectAssignmentInitializer);
      return;
    }
    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      visitModifiers(node);
      visitPropertyName(node.name);
      if (!ts.isPropertyDeclaration(node)) {
        for (const parameter of node.parameters) visit(parameter);
        if (node.body) visit(node.body);
      } else if (node.initializer) {
        visit(node.initializer);
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      visitModifiers(node);
      for (const parameter of node.parameters) visit(parameter);
      if (node.body) visit(node.body);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitModifiers(node);
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) visit(type.expression);
      }
      for (const member of node.members) visit(member);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      visitBindingName(node.name);
      if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isParameter(node)) {
      visitModifiers(node);
      visitBindingName(node.name);
      if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isLabeledStatement(node)) {
      visit(node.statement);
      return;
    }
    if (ts.isBreakOrContinueStatement(node) || ts.isMetaProperty(node)) return;
    ts.forEachChild(node, visit);
  }

  visit(root);
}

/** Records `require`/`import()` targets, file reads and stack references made by a call */
function inspectCall(node: ts.CallExpression | ts.NewExpression, item: Item) {
  const callee = node.expression;
  const firstArgument = node.arguments?.[0];
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  if (ts.isCallExpression(node) && (isRequire || isDynamicImport)) {
    const specifier = firstArgument && stringValue(firstArgument);
    if (specifier !== undefined) {
      item.refs.push({ kind: 'module', specifier });
    } else {
      item.unanalysable.push(`${isRequire ? 'require' : 'import'}() with a computed path`);
    }
    return;
  }

  // require.resolve("./file") names a file next to the module, or a package
  const isRequireResolve =
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require' &&
    callee.name.text === 'resolve';
  if (isRequireResolve && firstArgument) {
    item.resolved.push(firstArgument);
    return;
  }

  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  // Code built from strings, and requires made by createRequire, can't be followed
  // Only the globals: `new aws.lambda.Function(...)` is a resource, not code from a string
  const isGlobal = ts.isIdentifier(callee);
  if (isGlobal && (name === 'eval' || name === 'Function')) {
    item.unanalysable.push(
      `${name === 'eval' ? 'eval()' : 'new Function()'} runs code that can't be analysed`,
    );
  }
  if (name === 'createRequire') {
    item.unanalysable.push("createRequire() makes requires that can't be followed");
  }
  // process.loadEnvFile() reads .env from the working directory
  if (name === 'loadEnvFile' && ts.isPropertyAccessExpression(callee)) {
    item.assets.push(firstArgument ?? ts.factory.createStringLiteral('.env'));
    return;
  }
  if (!name || !firstArgument) return;
  // A method merely named like a reader (zip.readFile, handle.readFile) isn't one; Pulumi's
  // asset classes, a bare call, and calls through a file-system binding (checked once imports
  // are known) are
  const isAssetClass = name === 'FileAsset' || name === 'FileArchive';
  if (isAssetClass || (ts.isIdentifier(callee) && ASSET_READERS.has(name))) {
    item.assets.push(firstArgument);
  }
  const object = ts.isPropertyAccessExpression(callee)
    ? rootIdentifier(callee.expression)
    : undefined;
  if (ts.isIdentifier(callee) || object !== undefined) {
    item.calls.push({ object, name, argument: firstArgument });
  }
  if (name === 'StackReference' && ts.isNewExpression(node)) {
    item.stackReferences.push({
      name: stackReferenceName(node) ?? firstArgument,
      outputs: outputsRead(node),
      ordinal: stackReferences(node.getSourceFile()).indexOf(node),
      total: stackReferences(node.getSourceFile()).length,
    });
  }
}

/** `fs` in `fs.promises.readFile`: the identifier a member chain starts from */
function rootIdentifier(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return rootIdentifier(node.expression);
  return undefined;
}

/** A string that names a module to load rather than a file to read */
function isModuleSpecifier(node: ts.Node) {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require'
  );
}

/** StackReference methods that read one output, named by their first argument */
const OUTPUT_READERS = new Set([
  'getOutput',
  'requireOutput',
  'getOutputValue',
  'requireOutputValue',
  'getOutputDetails',
]);

/**
 * The outputs a program reads from a stack reference: through its output methods or
 * `.outputs.name`, directly on the `new` expression or on the constant it's assigned to in the
 * same module. A reference used any other way (exported, passed to a function, its outputs
 * spread) could have any output read, so it reads "all".
 */
function outputsRead(node: ts.NewExpression): StackReferenceUse['outputs'] {
  let reference: ts.Expression = node;
  while (ts.isParenthesizedExpression(reference.parent) || ts.isAsExpression(reference.parent)) {
    reference = reference.parent as ts.Expression;
  }
  const declaration = reference.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer !== reference
  ) {
    const read = readAt(reference);
    return read === undefined ? 'all' : [read];
  }
  const statement = declaration.parent?.parent;
  if (
    statement &&
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return 'all';
  }
  const binding = declaration.name.text;
  const reads: ts.Expression[] = [];
  let escapes = false;
  const visit = (current: ts.Node) => {
    if (escapes) return;
    if (ts.isIdentifier(current) && current.text === binding && current !== declaration.name) {
      // A property name or a key that happens to match isn't a use
      const parent = current.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current);
      if (!isName) {
        const read = readAt(current);
        if (read === undefined) escapes = true;
        else reads.push(read);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node.getSourceFile());
  return escapes ? 'all' : reads;
}

/** The output name read where `reference` is used, if it's used to read one output */
function readAt(reference: ts.Expression): ts.Expression | undefined {
  const parent = reference.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== reference) return undefined;
  const member = parent.name.text;
  if (OUTPUT_READERS.has(member)) {
    const call = parent.parent;
    if (ts.isCallExpression(call) && call.expression === parent && call.arguments[0]) {
      return call.arguments[0];
    }
    return undefined;
  }
  if (member === 'outputs') {
    // `ref.outputs.name` or `ref.outputs["name"]`; the whole `outputs` object could be any
    const access = parent.parent;
    if (ts.isPropertyAccessExpression(access) && access.expression === parent) {
      return ts.factory.createStringLiteral(access.name.text);
    }
    if (ts.isElementAccessExpression(access) && access.expression === parent) {
      return access.argumentExpression;
    }
  }
  return undefined;
}

/** `new StackReference(resourceName, { name })` refers to `name` when it's given */
function stackReferenceName(node: ts.NewExpression) {
  const args = node.arguments?.[1];
  if (!args || !ts.isObjectLiteralExpression(args)) return undefined;
  for (const property of args.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === 'name') {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'name') {
      return property.name;
    }
  }
  return undefined;
}

/** True for expressions that run no code of their own when evaluated */
export function isPure(node: ts.Expression): boolean {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isIdentifier(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return true;
  }
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ThisKeyword:
      return true;
  }
  if (ts.isClassExpression(node)) return isPureClass(node);
  if (ts.isParenthesizedExpression(node)) return isPure(node.expression);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((s) => isPure(s.expression));
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) =>
      ts.isSpreadElement(element) ? isPure(element.expression) : isPure(element),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isPropertyAssignment(property)) {
        const name = property.name;
        const pureName = !ts.isComputedPropertyName(name) || isPure(name.expression);
        return pureName && isPure(property.initializer);
      }
      if (ts.isSpreadAssignment(property)) return isPure(property.expression);
      return true;
    });
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const mutates =
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken;
    return !mutates && isPure(node.operand);
  }
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) return isPure(node.expression);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    const assigns =
      operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
    return !assigns && isPure(node.left) && isPure(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return isPure(node.condition) && isPure(node.whenTrue) && isPure(node.whenFalse);
  }
  // Reading a property can run a getter, so it isn't pure, unless it's a member of something
  // imported: a namespace's constants and enums (aws.ec2.InstanceType.T3_Micro)
  if (ts.isPropertyAccessExpression(node)) {
    const root = rootIdentifier(node);
    return root !== undefined && importedNames.has(root);
  }
  return false;
}

/** A class runs code at definition time through static members, decorators or `extends f()` */
function isPureClass(node: ts.ClassLikeDeclaration) {
  if (ts.getDecorators(node)?.length) return false;
  for (const clause of node.heritageClauses ?? []) {
    if (!clause.types.every((type) => isPure(type.expression))) return false;
  }
  return node.members.every((member) => {
    if (ts.isClassStaticBlockDeclaration(member)) return false;
    // Computed member names are evaluated when the class is defined
    if (member.name && ts.isComputedPropertyName(member.name) && !isPure(member.name.expression)) {
      return false;
    }
    if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) return false;
    const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
    const isStatic = modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
      return isPure(member.initializer);
    }
    return true;
  });
}

function isCommonJs(source: ts.SourceFile) {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const object = node.expression.text;
      if ((object === 'module' && node.name.text === 'exports') || object === 'exports') {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) continue;
    visit(statement);
  }
  return found;
}

function variableKeyword(list: ts.VariableDeclarationList) {
  if (list.flags & ts.NodeFlags.Const) return 'const';
  if (list.flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

export function stringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/**
 * Reduces code to its tokens, so formatting differences between the base and head
 * transpilations (the emitter keeps some of the original line breaks) don't count as changes.
 * Tokens come from the parsed tree, so template literals and regular expressions stay whole.
 */
export function normalizeCode(node: ts.Node) {
  const tokens: string[] = [];
  const source = node.getSourceFile();
  const visit = (current: ts.Node) => {
    const children = current.getChildren(source);
    if (children.length === 0) {
      if (current.kind === ts.SyntaxKind.StringLiteral) {
        tokens.push(JSON.stringify((current as ts.StringLiteral).text));
      } else if (current.kind !== ts.SyntaxKind.EndOfFileToken) {
        tokens.push(current.getText(source));
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(node);
  return tokens.join(' ');
}

function parseJsonModule(path: string, text: string): ModuleInfo {
  let code: string;
  try {
    code = JSON.stringify(JSON.parse(text));
  } catch {
    code = text;
  }
  const source = ts.createSourceFile(path, '', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const item: Item = {
    key: 'default',
    names: ['default'],
    eager: true,
    code,
    refs: [],
    assets: [],
    calls: [],
    pathCandidates: [],
    resolved: [],
    siblings: [],
    hoisted: false,
    stackReferences: [],
    unanalysable: [],
  };
  return {
    path,
    opaque: true,
    imports: new Map(),
    loads: [],
    exports: new Map([['default', { kind: 'local', local: 'default' }]]),
    starExports: [],
    items: [item],
    itemsByName: new Map([['default', item]]),
    source,
    order: ['default'],
  };
}
