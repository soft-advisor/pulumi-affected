import ts from 'typescript';
import { dirnameOf } from "../snapshot.js";
/*
 * A small static evaluator for the strings that matter to selection: file paths a program reads,
 * and the names of stacks it references. It understands literals, templates, concatenation,
 * constants (including imported ones), path helpers and Pulumi's stack, project and config
 * functions. Anything else is unknown.
 */
/**
 * Marks a path as relative to a module's folder: `\0module:<folder>\0<rest>`. The folder is
 * the module that wrote `__dirname`, which isn't always the one that reads the path: a constant
 * imported from lib/paths.ts stays relative to lib/.
 */
const MODULE_DIR = '\u0000module:';
export function moduleDir(module) {
    return `${MODULE_DIR}${dirnameOf(module.path)}\u0000`;
}
/** Where a path evaluated from code is anchored, and the rest of it */
export function anchorOf(value) {
    if (value.startsWith(MODULE_DIR)) {
        const end = value.indexOf('\u0000', MODULE_DIR.length);
        return {
            anchor: 'module',
            dir: value.slice(MODULE_DIR.length, end),
            rest: value.slice(end + 1),
        };
    }
    if (value.startsWith(WORKING_DIR))
        return { anchor: 'cwd', rest: value.slice(WORKING_DIR.length) };
    return { anchor: 'none', rest: value };
}
/** Stands for the program's working directory: the project folder */
export const WORKING_DIR = '\u0000cwd';
/** Unknown parts of a stack name; stack names can't contain "*" */
export const WILDCARD = '*';
const MAX_DEPTH = 20;
export function evaluateString(node, module, context, depth = 0) {
    const unknown = context.unknown;
    if (depth > MAX_DEPTH)
        return unknown;
    const recurse = (inner, innerModule = module) => evaluateString(inner, innerModule, context, depth + 1);
    if (ts.isStringLiteralLike(node))
        return node.text;
    if (ts.isNumericLiteral(node))
        return node.text;
    if (ts.isParenthesizedExpression(node))
        return recurse(node.expression);
    if (ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node)) {
        return recurse(node.expression);
    }
    if (ts.isTemplateExpression(node)) {
        let result = node.head.text;
        for (const span of node.templateSpans) {
            const value = recurse(span.expression);
            if (value === undefined)
                return undefined;
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
        if (node.text === '__dirname')
            return moduleDir(module);
        // A parameter or local variable can hold anything; only module-level constants are known
        if (isLocallyBound(node))
            return unknown;
        const target = context.lookup(module, node.text);
        return target ? evaluateString(target.node, target.module, context, depth + 1) : unknown;
    }
    if (ts.isPropertyAccessExpression(node)) {
        if (ts.isMetaProperty(node.expression) && node.name.text === 'dirname')
            return moduleDir(module);
        return unknown;
    }
    if (ts.isCallExpression(node))
        return evaluateCall(node, module, context, depth) ?? unknown;
    if (ts.isNewExpression(node) && calleeName(node.expression) === 'URL') {
        // new URL("./file", import.meta.url)
        const [relative, base] = node.arguments ?? [];
        const isModuleUrl = base &&
            ts.isPropertyAccessExpression(base) &&
            ts.isMetaProperty(base.expression) &&
            base.name.text === 'url';
        const value = relative && recurse(relative);
        if (isModuleUrl && value !== undefined)
            return `${moduleDir(module)}/${value}`;
    }
    return unknown;
}
function evaluateCall(node, module, context, depth) {
    const name = calleeName(node.expression);
    const args = node.arguments.map((argument) => evaluateString(argument, module, context, depth + 1));
    switch (name) {
        case 'join':
        case 'resolve': {
            if (args.some((argument) => argument === undefined))
                return undefined;
            const parts = args;
            if (name === 'resolve') {
                // path.resolve restarts at the last absolute segment
                let start = 0;
                parts.forEach((part, index) => {
                    if (isAbsolute(part))
                        start = index;
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
function evaluateConfigRead(node, module, context, key) {
    if (!context.config || key === undefined)
        return undefined;
    if (!ts.isPropertyAccessExpression(node.expression))
        return undefined;
    let receiver = node.expression.expression;
    let receiverModule = module;
    if (ts.isIdentifier(receiver)) {
        const target = context.lookup(module, receiver.text);
        if (!target)
            return undefined;
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
function isLocallyBound(identifier) {
    const name = identifier.text;
    for (let node = identifier.parent; node && !ts.isSourceFile(node); node = node.parent) {
        if (ts.isFunctionLike(node)) {
            if (node.parameters.some((parameter) => bindsName(parameter.name, name)))
                return true;
        }
        if (ts.isCatchClause(node) &&
            node.variableDeclaration &&
            bindsName(node.variableDeclaration.name, name)) {
            return true;
        }
        if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
            node.initializer &&
            ts.isVariableDeclarationList(node.initializer) &&
            node.initializer.declarations.some((declaration) => bindsName(declaration.name, name))) {
            return true;
        }
        if (ts.isBlock(node) ||
            ts.isModuleBlock(node) ||
            ts.isCaseClause(node) ||
            ts.isDefaultClause(node)) {
            for (const statement of node.statements) {
                if (ts.isVariableStatement(statement)) {
                    const declarations = statement.declarationList.declarations;
                    if (declarations.some((declaration) => bindsName(declaration.name, name)))
                        return true;
                }
                if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
                    statement.name?.text === name) {
                    return true;
                }
            }
        }
    }
    return false;
}
function bindsName(binding, name) {
    if (ts.isIdentifier(binding))
        return binding.text === name;
    return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, name));
}
function calleeName(callee) {
    if (ts.isIdentifier(callee))
        return callee.text;
    if (ts.isPropertyAccessExpression(callee))
        return callee.name.text;
    return undefined;
}
function isAbsolute(path) {
    return path.startsWith('/') || path.startsWith(MODULE_DIR) || path.startsWith(WORKING_DIR);
}
