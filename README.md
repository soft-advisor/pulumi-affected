# pulumi-affected

Works out which Pulumi stacks a change affects, so CI previews and deploys only those. It follows what each stack's program actually runs, down to individual functions, instead of looking at which folders changed.

- A change to a shared function selects only the projects that call it.
- A dependency upgrade selects only the projects that load the package, directly or through other packages.
- Comments, formatting, types and docs select nothing.
- Stacks that read other stacks' outputs run after them, in waves.

It works with TypeScript and JavaScript Pulumi programs, and npm, yarn (classic and berry) and pnpm. It needs no Pulumi Cloud features and works with any backend.

## How detection works

For each project, at the base revision and at the head revision:

1. **The program.** Each file is transpiled the way Pulumi runs it (types erased, unused imports elided, comments dropped) and split into top-level items. Starting from the entry file, the tool follows what runs: every statement of every loaded module, and the functions and constants those use, transitively.
   - It follows relative imports, `import x = require()`, `tsconfig` path aliases (including through `extends` from a workspace package), `package.json` `imports` (`#alias`), workspace packages (through their `exports`, and from build output back to source), re-exports and namespace imports, plus files preloaded through `runtime.options.nodeargs`.
   - The entry file's exports count, because they're stack outputs.
   - Statement order counts too: import order, and declarations used before they're assigned.
   - A project is affected when any of that differs.
2. **Files and folders the program uses.**
   - Paths passed to any function of `fs`, `fs/promises`, `fs-extra` or the glob packages, under any name.
   - Paths given to `FileAsset`, `FileArchive` and `require.resolve`, and `.env` for dotenv.
   - Path-like values that name something in the repository: a `context`, `dockerfile`, `path`, `dir`, `location`, `cwd`, `source` or `file` property, or any `./` or `../` string. That covers Docker build contexts, Lambda folders and the like.
   - Paths can use `path.join(__dirname, …)`, `process.cwd()` (the folder Pulumi runs the program in) and constants.
3. **Packages.** The lockfile (npm, yarn classic or berry, pnpm 6+, or `bun.lock`) is read into a graph. A project is affected when a package it loads, or anything that package depends on, resolves differently: another version, another git commit or tarball, another checksum, or a changed patch, including patch-package's `patches/`.
   - The Pulumi SDK counts for every program, as do npm packages the tsconfig extends.
   - Without a lockfile, the dependency ranges in `package.json` are compared instead.
   - A lockfile that can't be read counts as changed whenever its text changes.
4. **Settings.** These are compared by value, with YAML scalars kept as written (so `1.10` and `1.1` differ):
   - `Pulumi.yaml`, except `description`, including `runtime.options.tsconfig`
   - compiler options that change the output, including strict mode
   - the `type`/`main`/`imports`/`exports` fields of `package.json`

A stack is affected when its project is, or when its `Pulumi.<stack>.yaml` differs by value. An encryption salt Pulumi adds to a stack's config file doesn't count, but a changed one does. Stack files follow the project file's extension (`Pulumi.dev.yml` belongs with `Pulumi.yml`).

Symbolic links are followed while they stay inside the repository. A submodule counts as changed when it moves to another commit.

Every selected stack comes with its reasons, for example ``lib/naming.ts: `zoneName` changed (via dns/index.ts)``.

**When analysis can't be complete,** the stack is selected by any change in its project's folder and in the folder where the missing piece most likely lives, and a warning says why. Examples: a `require()` with a computed path, `eval`, a file read from a path that can't be worked out, build output that isn't committed, an import the lockfile doesn't resolve. To keep the precision, list such files under `inputs` in the config. Projects in other languages are watched folder by folder; for Pulumi YAML, folders read with `fn::readFile` and friends count too.

**Dependencies between stacks** come from `new StackReference(name)` in code. Names built from constants, `pulumi.getStack()`, `getProject()`, `getOrganization()` and stack config values are resolved per stack. Dependencies that don't appear in code, such as a stack that looks up another stack's resources in the cloud, go under `dependsOn`. A dependency only orders stacks; it never selects one. When a stack's config changes, the stacks reading its outputs aren't previewed, because a preview reads the outputs as they are now and would show nothing.

## Forcing a stack

| How                                                                      | Example                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Touch a force file next to the stack's config: any edit, even whitespace | `accounts/Pulumi.business.force`, or `accounts/Pulumi.force` for every stack of the project |
| A line in a commit message or the pull request description               | `Pulumi-Affected-Run: dns/prod, accounts/*` (or `all`)                                      |
| A pull request comment, from someone with write access                   | `/pulumi-affected preview dns/prod`                                                         |
| Config                                                                   | `rules`, `always` (below)                                                                   |
| CLI / action input                                                       | `--run dns/prod`, `--all`                                                                   |

`Pulumi-Affected-Skip: <patterns>` leaves stacks out, unless something also requests them.

Stack patterns are `<project>/<stack>`, where `<project>` is the project's name or its folder, or a bare `<stack>` for that stack in every project. Both parts may be globs.

Stacks forced in a pull request, by its description or a comment, are also selected when it merges.

## Configuration

Optional: `pulumi-affected.yaml` at the repository root. The [schema](schema.json) gives editors completion.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/soft-advisor/pulumi-affected/main/schema.json
projects:
  include: ['**'] # folders with a Pulumi.yaml to consider
  exclude: ['examples/**']
stacks: [site/preview] # stacks without a Pulumi.<stack>.yaml
dependsOn:
  site/prod: [site/dev] # prod looks up dev's DNS zone in the cloud
rules:
  - when: ['scripts/pulumi.sh']
    run: [all]
always: [accounts/management]
inputs:
  lambdas/*: ['lambdas/src/**'] # files read from computed paths
globalInputs: ['.nvmrc', '.node-version'] # the default
packages:
  ignore: ['@types/*']
classify:
  ignore: # preview differences that aren't real changes
    - type: pulumi:providers:aws
      properties: [assumeRole, assumeRoles] # previews run with a read-only role
run:
  command: scripts/pulumi.sh {stack} # default: pulumi --cwd {dir} --stack {stack}
  concurrency: 4
  failFast: false
  newStacks: preview # or skip
```

## GitHub Actions

Two actions share the same selection:

- **`run`** previews or deploys the selected stacks in one job, in dependency order, and comments on pull requests. Use it when one set of credentials can reach every stack.
- **`select`** only outputs the selection, for a matrix of your own jobs, for example when stacks need different roles.

Both take the comparison base from the event:

| Event                                             | Compared with                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `pull_request`                                    | the merge base with the target branch                               |
| `push`                                            | the push's previous commit; a new branch selects everything         |
| `issue_comment` with `/pulumi-affected preview …` | the pull request's merge base; check out `refs/pull/<n>/head` first |
| anything else                                     | the `base` input                                                    |

Pin the actions to a commit SHA: jobs that preview and deploy usually hold credentials for your cloud accounts.

## Security

A preview runs the pull request's Pulumi program, so whoever can open a pull request can run code in a preview job. Plan credentials with that in mind:

- **Previews get read-only credentials; deploys get the rest.** Deploy only on pushes to protected branches, in a separate job or workflow, ideally behind a GitHub environment.
- **Forks.** `pull_request` runs from forks get no secrets, so their previews can't sign in. `pull_request_target` with a fork's code checked out is refused.
- **Comment commands** run only for people with write access, only on pull requests from this repository, and only for new comments. The action checks this itself, but also gate the job, so it doesn't even start for others:

  ```yaml
  on:
    issue_comment:
      types: [created]
  jobs:
    preview:
      if: >-
        github.event.issue.pull_request &&
        startsWith(github.event.comment.body, '/pulumi-affected') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
      steps:
        - uses: actions/checkout@v4
          with:
            ref: refs/pull/${{ github.event.issue.number }}/head
            fetch-depth: 0
        # read-only sign-in, then the run action with mode: preview
  ```

  A comment-triggered run's OIDC token says `ref: refs/heads/<default branch>`, so cloud trust policies for deploy roles should also check `event_name` or the workflow, not only the branch.
- **What Pulumi sees.** Pulumi runs without the job token, the runner's internal tokens and the files that set later steps' environment. It also can't request GitHub OIDC tokens unless `pass-oidc: true`.
- **Names.** Project and stack names that Pulumi wouldn't accept, and folders whose names contain quotes, `$`, backticks or newlines, are skipped with a warning. Wrapper scripts should still quote their arguments, or use the `PULUMI_AFFECTED_DIR`, `PULUMI_AFFECTED_STACK`, `PULUMI_AFFECTED_PROJECT` and `PULUMI_AFFECTED_ID` variables the command gets.
- **Comments and logs** show resource types, names and changed property names, never values. A failed stack shows Pulumi's error diagnostics.

**Concurrency.** Two deploys of the same stacks at once fight over stack locks, or apply out of order. Previews of the same pull request duplicate comments. Use concurrency groups:

```yaml
concurrency:
  # Deploys: one at a time, never cancelled midway
  group: pulumi-deploy
  cancel-in-progress: false
```

```yaml
concurrency:
  # Previews: the latest push of a pull request wins
  group: pulumi-preview-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
```

### `run`

```yaml
on:
  pull_request:
  push:
    branches: [main]

jobs:
  pulumi:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write # your cloud sign-in
      pull-requests: write # comments
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # history for the merge base and each stack's last deploy
      # your own Pulumi and cloud sign-in
      - uses: soft-advisor/pulumi-affected/run@<commit sha>
        with:
          mode: ${{ github.event_name == 'push' && 'up' || 'preview' }}
```

**Preview** runs every selected stack in parallel. A stack that doesn't exist yet is previewed in a temporary local backend with its config, so nothing is written to the real backend before merge. There, other stacks (`StackReference`), ESC environments and secrets encrypted by the real backend aren't available, so such a preview fails with an explanation. `run.newStacks: skip` leaves new stacks out of previews instead.

**Up** compares each stack with the commit it was last deployed from (Pulumi records it as `git.head` in the stack's history), so a stack whose deploy failed, or that was never deployed, runs again on the next push.

- A stack whose latest deploy failed is selected, with that reason.
- A stack whose last deploy recorded no commit, or used `--target`, is selected too.
- A destroyed stack counts as never deployed.
- A deploy from a working tree with uncommitted changes keeps its commit, with a warning. Stacks run after the ones they depend on. When a deploy changes a stack's outputs, the stacks that depend on it are deployed too, with the reason. A failure skips the stacks that depend on the failed one, lets the others finish, and fails the job at the end (`fail-fast` stops early instead).

**Comments.** A preview posts one comment on the pull request and edits it on every push: a table of stacks with their result and why they ran, then each stack's resource changes. A push that selects nothing rewrites an earlier comment rather than adding one. A deploy comments its results on the pull requests the push merged. GitHub limits a comment to 65,536 characters, so a long report continues in further comments, split between stacks. Resource changes show types, names and changed property names, never values; a failed stack shows the error Pulumi printed. Pull requests from forks can't be commented on with the default token; the job summary has everything.

**Inputs:** `mode` (`preview` or `up`), `command`, `concurrency`, `fail-fast`, `comment`, `pass-oidc`, `base`, `head`, `run`, `skip`, `all`, `pull-request`, `working-directory`, `github-token`.
**Outputs:** `results` (JSON array of `{ id, status, reasons, counts, changedOutputs, newStack, error }`, status being `changes`, `no-changes`, `failed` or `skipped`), `changed`, `failed`, `any-changes`.

### `select`

```yaml
jobs:
  select:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write # replies to /pulumi-affected commands from people without write access
    outputs:
      stacks: ${{ steps.select.outputs.stacks }}
      any: ${{ steps.select.outputs.any }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: select
        uses: soft-advisor/pulumi-affected/select@<commit sha>

  preview:
    needs: select
    if: needs.select.outputs.any == 'true'
    strategy:
      fail-fast: false
      matrix:
        stack: ${{ fromJSON(needs.select.outputs.stacks) }}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      # your own Pulumi and cloud sign-in
      # Through env, never ${{ }} inside the script: the values come from repository files
      - run: pulumi preview --cwd "$STACK_DIR" --stack "$STACK_NAME"
        env:
          STACK_DIR: ${{ matrix.stack.dir }}
          STACK_NAME: ${{ matrix.stack.stack }}
```

To deploy only stacks whose last deploy is older than the change, pass `bases`: a JSON object from stack id to the commit each was last deployed from, or `null` for a stack never deployed.

**Inputs:** `base`, `head`, `bases`, `run`, `skip`, `all`, `pull-request`, `working-directory`, `github-token`.
**Outputs:** `stacks` (JSON array of `{ id, project, dir, stack, configFile, wave, reasons }`), `ids`, `waves`, `any`, `result`.

## CLI

```sh
npx @soft-advisor/pulumi-affected select --base origin/main [--format markdown]
npx @soft-advisor/pulumi-affected dependents accounts/business [--transitive]
npx @soft-advisor/pulumi-affected run --mode preview --base origin/main [--format markdown]
pulumi preview --json | npx @soft-advisor/pulumi-affected classify
```

`select` analyses the working tree unless `--head` is given; `run` analyses `HEAD`. `classify` exits 0 when the preview changes something and 3 when it doesn't. See `--help` for every option.

## Development

Node 24 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm lint        # Biome lint + format check
pnpm typecheck
pnpm test
pnpm build       # also rebuilds select/dist, run/dist and schema.json, which are committed
```

Tests build real git repositories in a temporary folder. `test/run.test.ts` drives the real `pulumi` CLI against a local file backend, and is skipped when the CLI isn't installed. `e2e/fixtures` holds Pulumi projects with realistic layouts, and `e2e/scenarios.json` the changes and the stacks each should select. The CI `dogfood` job runs the action from each commit against those fixtures.

## Releasing

Bump `version` in `package.json` in a PR; merging it publishes to npm with provenance and tags the commit `v<version>` and `v<major>` ([`publish.yml`](.github/workflows/publish.yml)).

npm trusted publishing (GitHub OIDC, no token) can only be set up for a package that already exists, so:

1. The first version is published with a short-lived npm token in the `NPM_TOKEN` repository secret.
2. On npmjs.com, the package's Settings → Trusted publisher is set to GitHub Actions, repository `soft-advisor/pulumi-affected`, workflow `publish.yml`.
3. The `NPM_TOKEN` secret is deleted and the token revoked.
