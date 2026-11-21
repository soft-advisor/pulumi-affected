import ts from 'typescript';
import type { ModuleInfo } from './module.ts';

/*
 * A small static evaluator for the strings that matter to selection: file paths a program reads,
 * and the names of stacks it references. It understands literals, templates, concatenation,
 * constants (including imported ones), path helpers and Pulumi's stack, project and config
 * functions. Anything else is unknown.
 */

/** Stands for the folder of the module being evaluated */
export const MODULE_DIR = '\u0000module';
/** Stands for the program's working directory: the project folder */
export const WORKING_DIR = '\u0000cwd';
/** Unknown parts of a stack name; stack names can't contain "*" */
export const WILDCARD = '*';

export interface EvaluationContext {
  /** Finds the declaration a name refers to, following imports */
  lookup(module: ModuleInfo, name: string): { module: ModuleInfo; node: ts.Expression } | undefined;
  stack?: string;
  project?: string;
  /** Reads a stack config value as a string, e.g. ("my-project", "accounts") */
  config?(namespace: string, key: string): string | undefined;
  /** What unknown parts evaluate to; undefined makes the whole result unknown */
  unknown: typeof WILDCARD | undefined;
}

const MAX_DEPTH = 20;

export function evaluateString(
  node: ts.Expression,
  module: ModuleInfo,
  context: EvaluationContext,
  depth = 0,
): string | undefined {
  const unknown = context.unknown;
  if (depth > MAX_DEPTH) return unknown;
  const recurse = (inner: ts.Expression, innerModule = module) =>
    evaluateString(inner, innerModule, context, depth + 1);

  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return recurse(node.expression);
  if (
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return recurse(node.expression);
  }

  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = recurse(span.expression);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = recurse(node.left);
    const right = recurse(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }

  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname') return MODULE_DIR;
    // A parameter or local variable can hold anything; only module-level constants are known
    if (isLocallyBound(node)) return unknown;
    const target = context.lookup(module, node.text);
    return target ? evaluateString(target.node, target.module, context, depth + 1) : unknown;
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isMetaProperty(node.expression) && node.name.text === 'dirname') return MODULE_DIR;
    return unknown;
  }

  if (ts.isCallExpression(node)) return evaluateCall(node, module, context, depth) ?? unknown;

  if (ts.isNewExpression(node) && calleeName(node.expression) === 'URL') {
    // new URL("./file", import.meta.url)
    const [relative, base] = node.arguments ?? [];
    const isModuleUrl =
      base &&
      ts.isPropertyAccessExpression(base) &&
      ts.isMetaProperty(base.expression) &&
      base.name.text === 'url';
    const value = relative && recurse(relative);
    if (isModuleUrl && value !== undefined) return `${MODULE_DIR}/${value}`;
  }
  return unknown;
}

function evaluateCall(
  node: ts.CallExpression,
  module: ModuleInfo,
  context: EvaluationContext,
  depth: number,
): string | undefined {
  const name = calleeName(node.expression);
  const args = node.arguments.map((argument) =>
    evaluateString(argument, module, context, depth + 1),
  );
  switch (name) {
    case 'join':
    case 'resolve': {
      if (args.some((argument) => argument === undefined)) return undefined;
      const parts = args as string[];
      if (name === 'resolve') {
        // path.resolve restarts at the last absolute segment
        let start = 0;
        parts.forEach((part, index) => {
          if (isAbsolute(part)) start = index;
        });
        return parts.slice(start).join('/');
      }
      return parts.join('/');
    }
    case 'cwd':
      return WORKING_DIR;
    case 'fileURLToPath':
      return args[0];
    case 'getStack':
      return context.stack;
    case 'getProject':
      return context.project;
    case 'getOrganization':
      return undefined;
    case 'require':
    case 'get':
    case 'requireSecret':
    case 'getSecret':
      return evaluateConfigRead(node, module, context, args[0]);
  }
  return undefined;
}

/** `config.require("key")` where `config` is a `new pulumi.Config(namespace?)` */
function evaluateConfigRead(
  node: ts.CallExpression,
  module: ModuleInfo,
  context: EvaluationContext,
  key: string | undefined,
) {
  if (!context.config || key === undefined) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  let receiver: ts.Expression = node.expression.expression;
  let receiverModule = module;
  if (ts.isIdentifier(receiver)) {
    const target = context.lookup(module, receiver.text);
    if (!target) return undefined;
    receiver = target.node;
    receiverModule = target.module;
  }
  if (!ts.isNewExpression(receiver) || calleeName(receiver.expression) !== 'Config') {
    return undefined;
  }
  const namespaceArgument = receiver.arguments?.[0];
  const namespace = namespaceArgument
    ? evaluateString(namespaceArgument, receiverModule, { ...context, unknown: undefined })
    : context.project;
  return namespace === undefined ? undefined : context.config(namespace, key);
}

/** True when the name refers to a parameter or variable of an enclosing function or block */
function isLocallyBound(identifier: ts.Identifier) {
  const name = identifier.text;
  for (
    let node: ts.Node | undefined = identifier.parent;
    node && !ts.isSourceFile(node);
    node = node.parent
  ) {
    if (ts.isFunctionLike(node)) {
      if (node.parameters.some((parameter) => bindsName(parameter.name, name))) return true;
    }
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      bindsName(node.variableDeclaration.name, name)
    ) {
      return true;
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.some((declaration) => bindsName(declaration.name, name))
    ) {
      return true;
    }
    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          const declarations = statement.declarationList.declarations;
          if (declarations.some((declaration) => bindsName(declaration.name, name))) return true;
        }
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

function calleeName(callee: ts.Expression) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isAbsolute(path: string) {
  return path.startsWith('/') || path.startsWith(MODULE_DIR) || path.startsWith(WORKING_DIR);
}
