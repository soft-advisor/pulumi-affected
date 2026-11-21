import { parse } from 'yaml';
import { matchesAnyGlob } from "./patterns.js";
import { dirnameOf, joinPath } from "./snapshot.js";
const PROJECT_FILE = /(^|\/)Pulumi\.(ya?ml|json)$/;
const STACK_FILE = /^Pulumi\.(.+)\.(ya?ml|json)$/;
export class ProjectError extends Error {
}
/*
 * Names reach shell commands and workflow expressions, so anything outside what Pulumi itself
 * accepts is left out with a warning rather than quoted and hoped for.
 */
/** Pulumi's own rule for project and stack names */
const NAME = /^[A-Za-z0-9_.-]+$/;
/** Folders: letters, digits, spaces and a few punctuation marks; no quotes, $, backticks or newlines */
const FOLDER = /^[A-Za-z0-9 _.@+/-]*$/;
/** Finds every Pulumi project in the snapshot and its stacks */
export function discoverProjects(snapshot, config, warnings = []) {
    const projects = [];
    for (const file of snapshot.paths) {
        if (!PROJECT_FILE.test(file) || file.split('/').includes('node_modules'))
            continue;
        const dir = dirnameOf(file);
        const dirForGlobs = dir === '' ? '.' : dir;
        // "**" means everywhere, including the root, which globs call "."
        const included = matchesAnyGlob(config.projects.include, dirForGlobs) ||
            (dir === '' && config.projects.include.includes('**'));
        if (!included)
            continue;
        if (matchesAnyGlob(config.projects.exclude, dirForGlobs))
            continue;
        if (!FOLDER.test(dir)) {
            warnings.push(`${file} is in a folder whose name has characters that aren't safe in commands; skipped`);
            continue;
        }
        let project;
        try {
            project = readProject(snapshot, file, warnings);
        }
        catch (error) {
            // A template's Pulumi.yaml (name: ${PROJECT}) or a broken one mustn't stop the others
            if (!(error instanceof ProjectError))
                throw error;
            warnings.push(`${error.message}; skipped`);
            continue;
        }
        if (!NAME.test(project.name)) {
            warnings.push(`${file}: project name "${project.name}" isn't a valid Pulumi name; skipped`);
            continue;
        }
        const sameName = projects.find((other) => other.name === project.name);
        if (sameName) {
            const message = `Projects in "${sameName.dir || '.'}" and "${dir || '.'}" are both named "${project.name}"`;
            // Only an error when both have stacks; otherwise one is an example or template
            if (sameName.stacks.length > 0 && project.stacks.length > 0) {
                throw new ProjectError(`${message}; stack ids would be ambiguous`);
            }
            warnings.push(`${message}; the one without stacks is skipped`);
            if (project.stacks.length === 0)
                continue;
            projects.splice(projects.indexOf(sameName), 1);
        }
        projects.push(project);
    }
    for (const extra of config.stacks) {
        const slash = extra.lastIndexOf('/');
        const projectRef = extra.slice(0, slash);
        const stack = extra.slice(slash + 1);
        if (!NAME.test(stack)) {
            warnings.push(`stacks: "${stack}" isn't a valid Pulumi stack name; skipped`);
            continue;
        }
        const project = projects.find((p) => p.name === projectRef || (p.dir || '.') === projectRef);
        if (!project)
            throw new ProjectError(`stacks: no project matches "${projectRef}"`);
        if (!project.stacks.some((s) => s.stack === stack)) {
            const extension = project.file.slice(project.file.lastIndexOf('.') + 1);
            project.stacks.push(makeStack(project, stack, `Pulumi.${stack}.${extension}`));
        }
    }
    for (const project of projects)
        project.stacks.sort((a, b) => a.stack.localeCompare(b.stack));
    return projects.sort((a, b) => a.dir.localeCompare(b.dir));
}
/** Reads one project; `file` is the path of its Pulumi.yaml */
export function readProject(snapshot, file, warnings = []) {
    const dir = dirnameOf(file);
    const settings = parseProjectFile(snapshot.read(file) ?? '', file);
    const stackConfigDir = joinPath(dir, settings.stackConfigDir ?? '');
    const project = {
        name: settings.name,
        dir,
        file,
        runtime: settings.runtime,
        runtimeOptions: settings.runtimeOptions,
        main: settings.main,
        stackConfigDir,
        stacks: [],
    };
    // Pulumi reads stack files with the project file's own extension: Pulumi.dev.yml goes with
    // Pulumi.yml, and Pulumi.dev.yaml with Pulumi.yaml
    const extension = file.slice(file.lastIndexOf('.') + 1);
    for (const path of snapshot.paths) {
        if (dirnameOf(path) !== stackConfigDir)
            continue;
        const match = STACK_FILE.exec(path.slice(path.lastIndexOf('/') + 1));
        if (!match || match[2] !== extension)
            continue;
        if (!NAME.test(match[1])) {
            warnings.push(`${path}: "${match[1]}" isn't a valid Pulumi stack name; skipped`);
            continue;
        }
        project.stacks.push(makeStack(project, match[1], match[0]));
    }
    project.stacks.sort((a, b) => a.stack.localeCompare(b.stack));
    return project;
}
function makeStack(project, stack, fileName) {
    return {
        id: `${project.name}/${stack}`,
        project: project.name,
        dir: project.dir,
        stack,
        configFile: joinPath(project.stackConfigDir, fileName),
    };
}
export function parseProjectFile(text, file) {
    let raw;
    try {
        raw = parse(text);
    }
    catch {
        throw new ProjectError(`${file} isn't valid YAML`);
    }
    if (!raw || typeof raw.name !== 'string') {
        throw new ProjectError(`${file} has no project name`);
    }
    // A template's name is a placeholder; a real project may keep the template: section it was
    // created from
    if ('template' in raw && /\$\{|\{\{/.test(raw.name)) {
        throw new ProjectError(`${file} is a project template`);
    }
    const runtime = raw.runtime;
    const runtimeName = typeof runtime === 'string'
        ? runtime
        : typeof runtime === 'object' && runtime !== null && 'name' in runtime
            ? String(runtime.name)
            : 'unknown';
    const options = typeof runtime === 'object' && runtime !== null && 'options' in runtime
        ? runtime.options
        : undefined;
    return {
        name: raw.name,
        runtime: runtimeName,
        runtimeOptions: typeof options === 'object' && options !== null ? options : {},
        main: typeof raw.main === 'string' ? raw.main : undefined,
        stackConfigDir: typeof raw.stackConfigDir === 'string' ? raw.stackConfigDir : undefined,
    };
}
