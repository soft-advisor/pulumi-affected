# pulumi-affected

Works out which Pulumi stacks a change affects, so CI previews and deploys only those. It follows what each stack's program actually runs, down to individual functions, instead of looking at which folders changed.

- A change to a shared function selects only the projects that call it.
- A dependency upgrade selects only the projects that load the package, directly or through other packages.
- Comments, formatting, types and docs select nothing.
- Stacks that read other stacks' outputs run after them, in waves.

It works with TypeScript and JavaScript Pulumi programs, and npm, yarn (classic and berry) and pnpm. It needs no Pulumi Cloud features and works with any backend.

## How detection works

For each project, at the base revision and at the head revision:

1. **The program.** Each file is transpiled the way Pulumi runs it (types erased, unused imports elided, comments dropped) and split into top-level items. Starting from the entry file, the tool follows what runs: every statement of every loaded module, and the functions and constants those use, transitively, through relative imports, `tsconfig` path aliases, workspace packages, re-exports and namespace imports. The entry file's exports count, because they're stack outputs. A project is affected when any of that differs.
2. **Files the program reads.** Paths passed to `readFileSync`, `readdirSync`, `FileAsset`, `FileArchive` and friends, including `path.join(__dirname, …)` and constants.
3. **Packages.** The lockfile is read into a graph. A project is affected when a package it loads, or anything that package depends on, resolves to a different version. The Pulumi SDK counts for every program.
4. **Settings.** `Pulumi.yaml` (except `description`), compiler options that change the output, and the `type`/`main`/`imports`/`exports` fields of `package.json`, all compared by value, not text.

A stack is affected when its project is, or when its `Pulumi.<stack>.yaml` differs by value.

Every selected stack comes with its reasons, for example ``lib/naming.ts: `zoneName` changed (via dns/index.ts)``.

**When analysis can't be complete,** for example a `require()` with a computed path or a file read from a path that can't be worked out, the project falls back to "any change in its folder counts", and a warning says why. List such files under `inputs` in the config to keep the precision.

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
```

## GitHub Action

```yaml
on:
  pull_request:
  push:
    branches: [main]

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
          fetch-depth: 0 # history for the merge base
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
      - run: pulumi preview --cwd "${{ matrix.stack.dir }}" --stack "${{ matrix.stack.stack }}"
```

Pin the action to a commit SHA: jobs that preview and deploy usually hold credentials for your cloud accounts.

The comparison base comes from the event:

| Event                                             | Compared with                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `pull_request`                                    | the merge base with the target branch                               |
| `push`                                            | the push's previous commit; a new branch selects everything         |
| `issue_comment` with `/pulumi-affected preview …` | the pull request's merge base; check out `refs/pull/<n>/head` first |
| anything else                                     | the `base` input                                                    |

To deploy only stacks whose last deploy is older than the change, pass `bases`: a JSON object from stack id to the commit each was last deployed from (Pulumi records it as `git.head` in `pulumi stack history --json`), or `null` for a stack never deployed. A stack whose deploy failed is then picked up again by the next run.

**Inputs:** `base`, `head`, `bases`, `run`, `skip`, `all`, `working-directory`, `github-token`.
**Outputs:** `stacks` (JSON array of `{ id, project, dir, stack, configFile, wave, reasons }`), `ids`, `waves`, `any`, `result`.

## CLI

```sh
npx @soft-advisor/pulumi-affected select --base origin/main [--format markdown]
npx @soft-advisor/pulumi-affected dependents accounts/business [--transitive]
```

`select` analyses the working tree unless `--head` is given. See `--help` for every option.

## Development

Node 24 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm lint        # Biome lint + format check
pnpm typecheck
pnpm test
pnpm build       # also rebuilds select/dist and schema.json, which are committed
```

Tests build real git repositories in a temporary folder. `e2e/fixtures` holds Pulumi projects with realistic layouts, and `e2e/scenarios.json` the changes and the stacks each should select. The CI `dogfood` job runs the action from each commit against those fixtures.

## Releasing

Bump `version` in `package.json` in a PR; merging it publishes to npm with provenance and tags the commit `v<version>` and `v<major>` ([`publish.yml`](.github/workflows/publish.yml)).

npm trusted publishing (GitHub OIDC, no token) can only be set up for a package that already exists, so:

1. The first version is published with a short-lived npm token in the `NPM_TOKEN` repository secret.
2. On npmjs.com, the package's Settings → Trusted publisher is set to GitHub Actions, repository `soft-advisor/pulumi-affected`, workflow `publish.yml`.
3. The `NPM_TOKEN` secret is deleted and the token revoked.
