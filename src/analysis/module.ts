import { createHash } from 'node:crypto';
import ts from 'typescript';

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
  /** Name expressions of `new StackReference(...)` */
  stackReferences: ts.Expression[];
  /** Why this item can't be analysed precisely, e.g. a `require` with a computed path */
  unanalysable: string[];
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
}

const ASSET_READERS = new Set([
  'readFileSync',
  'readFile',
  'createReadStream',
  'readdirSync',
  'readdir',
  'FileAsset',
  'FileArchive',
]);

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
      module: ts.ModuleKind.ESNext,
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
  };
  const anonymous = new Map<string, number>();
  const addItem = (item: Item) => {
    if (module.opaque) item.eager = true;
    module.items.push(item);
    for (const name of item.names) module.itemsByName.set(name, item);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = stringValue(statement.moduleSpecifier);
      if (specifier === undefined) continue;
      module.loads.push(specifier);
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
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && stringValue(statement.moduleSpecifier);
      if (specifier !== undefined) module.loads.push(specifier);
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
      addItem(makeItem(name, [name], eager, statement));
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
    // Keyed by content rather than position, so inserting a statement doesn't make every later
    // one look changed; the module's statement order is compared separately
    const item = makeItem('', [], true, statement);
    const contentKey = `#${createHash('sha256').update(item.code).digest('hex').slice(0, 10)}`;
    const occurrence = (anonymous.get(contentKey) ?? 0) + 1;
    anonymous.set(contentKey, occurrence);
    item.key = occurrence === 1 ? contentKey : `${contentKey}.${occurrence}`;
    addItem(item);
  }
  return module;
}

function makeItem(key: string, names: string[], eager: boolean, node: ts.Node, prefix = ''): Item {
  const item: Item = {
    key,
    names,
    eager,
    code: `${prefix} ${normalizeCode(node)}`.trim(),
    refs: [],
    assets: [],
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
      visit(node.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
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

  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (!name || !firstArgument) return;
  if (ASSET_READERS.has(name)) item.assets.push(firstArgument);
  if (name === 'StackReference' && ts.isNewExpression(node)) {
    item.stackReferences.push(stackReferenceName(node) ?? firstArgument);
  }
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
  if (ts.isPropertyAccessExpression(node)) return isPure(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return isPure(node.expression) && isPure(node.argumentExpression);
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
  };
}
