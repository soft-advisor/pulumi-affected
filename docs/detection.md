# How detection works

For each project, at the base revision and at the head revision:

1. **The program.** Each file is transpiled the way Pulumi runs it (types erased, unused imports elided, comments dropped) and split into top-level items. Starting from the entry file, the tool follows what runs: every statement of every loaded module, and the functions and constants those use, transitively.
   - It follows relative imports, `import x = require()`, `tsconfig` path aliases (including through `extends` from a workspace package), `package.json` `imports` (`#alias`), workspace packages (through their `exports`, and from build output back to source), re-exports and namespace imports, plus files preloaded through `runtime.options.nodeargs`.
   - The entry is what Pulumi runs: `main` from `Pulumi.yaml`, or the nearest `package.json`'s `exports` or `main`, or the index file. The program runs in its own folder (a `main` file's folder), reading that folder's `tsconfig.json` or `runtime.options.tsconfig`, as Pulumi does.
   - The entry file's exports count, because they're stack outputs, and so does which binding each import and export refers to.
   - Statement order counts when it can matter: imports of local modules that run code, and declarations used before they're assigned. Sorting package imports or moving a function doesn't count.
   - Workspace packages are those a workspace declares (`workspaces` in `package.json`, or `pnpm-workspace.yaml`), so a stray `package.json` never stands in for an npm package.
   - A project is affected when any of that differs.
2. **Files and folders the program uses.**
   - Paths passed to any function of `fs`, `fs/promises`, `fs-extra` or the glob packages, under any name.
   - Paths given to `FileAsset`, `FileArchive` and `require.resolve`, and `.env` for dotenv.
   - Path-like values that name something in the repository: a `context`, `dockerfile`, `path`, `dir`, `location`, `cwd`, `source` or `file` property (shorthand too), or any `./` or `../` string. That covers Docker build contexts, Lambda folders and the like. A bare `./`, a program's own source, or a folder holding the project only count as a Docker `context`, so ordinary strings don't make every change count; a `context` that can't be worked out is a gap.
   - Paths can use `path.join(__dirname, …)` (relative to the module that wrote it, even through an imported constant), `process.cwd()` (the folder Pulumi runs the program in) and constants.
3. **Packages.** The lockfile (npm, yarn classic or berry, pnpm 6+, or `bun.lock`) is read into a graph. A project is affected when a package it loads, or anything that package depends on, resolves differently: another version, another git commit or tarball, another checksum, or a changed patch, including patch-package's `patches/`.
   - The Pulumi SDK counts for every program, as do npm packages the tsconfig extends.
   - Without a lockfile, the dependency ranges in `package.json` are compared instead, and an import no `package.json` declares is a gap.
   - Packages from the registry compare by version, so a mirror switch or a new checksum format doesn't count; git, tarball and patched dependencies compare by source too.
   - With several lockfiles in one folder, `packageManager` in `package.json` picks one.
   - A lockfile that can't be read counts as changed whenever its text changes.
4. **Settings.** These are compared by value, with YAML scalars kept as written (so `1.10` and `1.1` differ):
   - `Pulumi.yaml`, except `description`, including `runtime.options.tsconfig`
   - compiler options that change the output, including strict mode
   - the `type`/`main`/`imports`/`exports` fields of `package.json`

A stack is affected when its project is, or when its `Pulumi.<stack>.yaml` differs by value. An encryption salt Pulumi adds to a stack's config file doesn't count, but a changed one does. Stack files follow the project file's extension (`Pulumi.dev.yml` belongs with `Pulumi.yml`).

Symbolic links are followed while they stay inside the repository. A submodule counts as changed when it moves to another commit. Projects can be `Pulumi.yaml`, `Pulumi.yml` or `Pulumi.json`, with stack files of the same extension; `runtime: bun` programs are analysed like Node.js ones.

**Not covered:**

- **Type-only changes** select nothing, because they don't change what's deployed. Pulumi does type-check TypeScript programs by default, so a type error would only show up when the stack next runs; run `tsc --noEmit` in CI to catch it.
- **ESC environments** imported in a stack's config change outside the repository; stacks using them get a warning. Select them with `always`, a rule or `Pulumi-Affected-Run` when an environment changes.
- **Stacks that only exist in the backend** (no `Pulumi.<stack>.yaml`) need listing under `stacks`.
- **Command templates** run with `/bin/sh`, so `run` needs Linux or macOS runners.

Every selected stack comes with its reasons, for example ``lib/naming.ts: `zoneName` changed (via dns/index.ts)``.

**When analysis can't be complete,** the stack is selected by any change in its project's folder and in the folder where the missing piece most likely lives, and a warning says why. Examples: a `require()` with a computed path, `eval`, a file read from a path that can't be worked out, build output that isn't committed, an import the lockfile doesn't resolve. To keep the precision, list such files under `inputs` in the config. Projects in other languages are watched folder by folder; for Pulumi YAML, folders read with `fn::readFile` and friends count too.

**Dependencies between stacks** come from `new StackReference(name)` in code. Names built from constants, `pulumi.getStack()`, `getProject()`, `getOrganization()` and stack config values are resolved per stack. Dependencies that don't appear in code, such as a stack that looks up another stack's resources in the cloud, go under `dependsOn`, which assumes every output is read (so changing any of them asks for the dependent to be planned again). When stacks only need to be applied in order, without reading each other's outputs, use `after`. A dependency only orders stacks; it never selects one. When a stack's config changes, the stacks reading its outputs aren't previewed, because a preview reads the outputs as they are now and would show nothing.

Forcing and skipping stacks are described in the [README](../README.md#forcing-a-stack).
