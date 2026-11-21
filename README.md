# pulumi-affected

Works out which Pulumi stacks a change affects, so CI plans only those. It follows what each stack's program actually runs, down to individual functions, instead of looking at which folders changed.

- A change to a shared function selects only the projects that call it.
- A dependency upgrade selects only the projects that load the package, directly or through other packages.
- Comments, formatting, types and docs select nothing.
- Stacks that read other stacks' outputs are ordered after them, in waves.

It works with TypeScript and JavaScript Pulumi programs, and npm, yarn (classic and berry) and pnpm. It needs no Pulumi Cloud features and works with any backend.

**It selects; it doesn't deploy.** The tool answers two questions: which stacks does this change affect (`select`), and, given their previews, which would actually change (`classify`). Running Pulumi, storing plans, commenting on pull requests and deciding when to apply stay in your own workflow, where you control credentials and approvals. [Example workflows](#example-workflows) show the usual patterns: plan on the pull request, apply exactly those plans after merge, or apply from a comment.

## How detection works

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

**Dependencies between stacks** come from `new StackReference(name)` in code. Names built from constants, `pulumi.getStack()`, `getProject()`, `getOrganization()` and stack config values are resolved per stack. Dependencies that don't appear in code, such as a stack that looks up another stack's resources in the cloud, go under `dependsOn`. A dependency only orders stacks; it never selects one. When a stack's config changes, the stacks reading its outputs aren't previewed, because a preview reads the outputs as they are now and would show nothing.

## Forcing a stack

| How                                                                      | Example                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Touch a force file next to the stack's config: any edit, even whitespace | `accounts/Pulumi.business.force`, or `accounts/Pulumi.force` for every stack of the project                                                 |
| A line in a commit message or the pull request description               | `Pulumi-Affected-Run: dns/prod, accounts/*` (or `all`)                                                                                      |
| Config                                                                   | `rules`, `always` (below)                                                                                                                   |
| CLI / action input                                                       | `--run dns/prod`, `--all`; a workflow can fill the `run` input from anything, such as a `workflow_dispatch` input or a pull request comment |

`Pulumi-Affected-Skip: <patterns>` leaves stacks out, unless something also requests them. Skipped stacks are listed in the output with what skipped them, so a skip is never silent.

Stack patterns are `<project>/<stack>`, where `<project>` is the project's name or its folder, or a bare `<stack>` for that stack in every project. Both parts may be globs.

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
```

## GitHub Actions

### `select`

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # history for the merge base
    persist-credentials: false
- id: select
  uses: soft-advisor/pulumi-affected/select@<commit sha>
  with:
    output-file: selection.json # for later jobs, e.g. as an artifact
```

The comparison base comes from the event: a pull request's merge base with its target branch, a push's previous commit (a new branch selects everything), a merge group's base; otherwise the `base` input.

**Inputs:** `base`, `head`, `bases`, `run`, `skip`, `all`, `working-directory`, `output-file`.
**Outputs:** `stacks` (JSON array of `{ id, project, dir, stack, configFile, wave, reasons }`, in wave order), `ids`, `waves`, `any`, `result` (everything, including skipped and unaffected stacks and warnings). The same JSON goes to `output-file`, and a summary to the job summary.

`bases` lets each stack compare with its own revision instead of `base`, e.g. the commit it was last deployed from (Pulumi records it as `git.head` in `pulumi stack history --json`), or `null` for a stack never deployed.

`select` only reads files: it never runs the repository's code, so it needs no credentials.

### `classify`

```yaml
- id: classify
  uses: soft-advisor/pulumi-affected/classify@<commit sha>
  with:
    previews: plans/*.preview.json # what `pulumi preview --json` printed, one file per stack
```

**Outputs:** `changed` and `unchanged` (JSON arrays of the preview files), `any`. A preview counts as changed when a resource would be created, updated, replaced or deleted. Reads and unchanged resources don't count, and neither does known noise listed under `classify.ignore`, such as a provider whose `assumeRole` differs because previews use a read-only role. Output that a wrapper script prints before Pulumi's JSON is skipped.

A preview usually can't tell whether **stack outputs alone** will change, so a stack whose only change is its outputs counts as unchanged. If other stacks read those outputs, keep its plan anyway.

## Example workflows

These are starting points: the tool's part is `select` and `classify`; everything else is yours to change. Both keep previews and applies apart: previews run the pull request's code with read-only credentials, applies run only reviewed code.

### Plan on the pull request, apply exactly those plans after merge

```yaml
# .github/workflows/plan.yml
on: pull_request
concurrency:
  group: plan-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
  id-token: write # read-only cloud role for previews; see Guardrails
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      # your read-only Pulumi and cloud sign-in, and dependency install
      - id: select
        uses: soft-advisor/pulumi-affected/select@<commit sha>
        with: { output-file: selection.json }
      - name: Preview the selected stacks, saving plans
        run: |
          mkdir -p plans
          while read -r stack; do
            id=$(jq -r .id <<<"$stack"); name=$(jq -r .stack <<<"$stack")
            dir=$(jq -r '.dir | if . == "" then "." else . end' <<<"$stack")
            file="plans/${id//\//__}"
            pulumi --cwd "$dir" stack select --create "$name"
            pulumi --cwd "$dir" --stack "$name" preview --json --save-plan "$PWD/$file.plan.json" > "$file.preview.json"
          done < <(jq -c '.stacks[]' selection.json)
      - id: classify
        uses: soft-advisor/pulumi-affected/classify@<commit sha>
        with: { previews: plans/*.preview.json }
      - name: Keep only the plans with changes
        env: { UNCHANGED: '${{ steps.classify.outputs.unchanged }}' }
        run: |
          jq -r '.[]' <<<"$UNCHANGED" | while read -r preview; do
            rm -f "$preview" "${preview%.preview.json}.plan.json"
          done
      - uses: actions/upload-artifact@v4
        with:
          name: plans-${{ github.event.pull_request.head.sha }}
          path: |
            selection.json
            plans/
```

```yaml
# .github/workflows/apply.yml
on:
  push:
    branches: [main]
concurrency:
  group: apply # one at a time, never cancelled midway
  cancel-in-progress: false
permissions:
  contents: read
  actions: read # to download the pull request's plans
  pull-requests: read
  id-token: write # deploy role
jobs:
  apply:
    runs-on: ubuntu-24.04
    environment: production # optional: a required reviewer, or branch restrictions
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - id: pr
        name: Find the merged pull request and its plan run
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls" --jq '.[0]')
          head=$(jq -r .head.sha <<<"$pr")
          run=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/plan.yml/runs?head_sha=$head&status=success" --jq '.workflow_runs[0].id')
          echo "head=$head" >> "$GITHUB_OUTPUT"; echo "run=$run" >> "$GITHUB_OUTPUT"
      - uses: actions/download-artifact@v4
        with:
          name: plans-${{ steps.pr.outputs.head }}
          run-id: ${{ steps.pr.outputs.run }}
          github-token: ${{ github.token }}
      - name: Refuse plans made from other code
        run: |
          git fetch --quiet origin "${{ steps.pr.outputs.head }}"
          [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse '${{ steps.pr.outputs.head }}^{tree}')" ]
      # your deploy-role cloud sign-in
      - name: Apply exactly the plans, in dependency order
        run: |
          for id in $(jq -r '.waves[][]' selection.json); do
            plan="plans/${id//\//__}.plan.json"
            [ -f "$plan" ] || continue
            stack=$(jq -c --arg id "$id" '.stacks[] | select(.id == $id)' selection.json)
            dir=$(jq -r '.dir | if . == "" then "." else . end' <<<"$stack")
            pulumi --cwd "$dir" --stack "$(jq -r .stack <<<"$stack")" up --yes --plan "$PWD/$plan"
          done
```

The tree check is what makes "apply exactly what was planned" hold: a squash merge of a branch that was up to date with `main` has the same tree as the pull request's head. If it doesn't (the branch wasn't up to date, or the plans are missing), the apply stops instead of planning again.

### Apply from a pull request comment (Atlantis-style)

A comment workflow runs from the default branch, with that branch's permissions, so it should run no code. Let it check what you require (the commenter's write access, an approval, passing checks) and then start a `workflow_dispatch` of an apply workflow **on the pull request's branch**, so the apply runs as that branch, not as `main`. The apply workflow downloads that pull request's latest plans and applies them as above; merge afterwards. Your cloud trust policy for the deploy role decides which branches and events may assume it.

To add stacks to a pull request's plans from a comment, the same comment workflow can dispatch the plan workflow on the pull request's branch with a `run` input, which the plan workflow passes to `select`.

## Guardrails and limitations

The tool selects; your repository's rules make plans safe to apply:

- **Applies only run reviewed code.** Require an approval to merge into the default branch, and dismiss approvals when new commits are pushed, so the approved plan is the applied plan.
- **Plans must not go stale.** Require branches to be up to date with the default branch before merging (or use a merge queue). Otherwise the plan was made against older code or state than what's merged, and the tree check above refuses it. Pulumi also refuses a plan whose resources no longer match it.
- **Make the plan a required check**, so a pull request can't merge with a failing preview.
- **One apply at a time**: a `concurrency` group that isn't cancelled midway. On self-managed backends, set `PULUMI_SELF_MANAGED_STATE_LOCKING`.
- **Credentials by event.** Previews run the pull request's code, so they get read-only roles. Give the deploy role a trust policy that only accepts the default branch's push (or the branches you apply from), and never give a job that runs a pull request's code a way to obtain it. Hiding variables from a step isn't isolation: code running in a job can read anything the job can.
- **Stacks that read a planned stack's outputs** are planned against its current outputs. If applying it changes them, the dependent's plan is rejected by Pulumi rather than applied; plan it again.
- **Type-only changes** select nothing, since they don't change what's deployed; run `tsc --noEmit` in CI to catch type errors before the next plan does.
- **ESC environments** change outside the repository; stacks importing them get a warning, and can be selected with `always`, a rule or `Pulumi-Affected-Run`.
- **Stacks that only exist in the backend** (no `Pulumi.<stack>.yaml`) need listing under `stacks`.
- **A safety net:** a scheduled run with `all: true` and `pulumi preview --expect-no-changes` catches drift and anything selection missed.

## CLI

The npm package isn't published yet; meanwhile, run `node src/cli.ts` from a checkout.

```sh
npx @soft-advisor/pulumi-affected select --base origin/main [--format markdown]
npx @soft-advisor/pulumi-affected dependents accounts/business [--transitive]
pulumi preview --json | npx @soft-advisor/pulumi-affected classify
```

`select` analyses the working tree unless `--head` is given. `classify` exits 0 when the preview changes something and 3 when it doesn't. See `--help` for every option.

## Development

Node 24 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm lint        # Biome lint + format check
pnpm typecheck
pnpm test
pnpm build       # also rebuilds select/dist, classify/dist and schema.json, which are committed
```

Tests build real git repositories in a temporary folder. The `E2E` workflow runs every scenario in `e2e/scenarios.json` for real in this repository: it deploys `e2e/fixtures` to a file backend, opens a pull request with the scenario's change, and runs the plan and apply example above on it, checking what was selected, planned and applied.

## Releasing

Publishing is manual for now ([`publish.yml`](.github/workflows/publish.yml) only runs on `workflow_dispatch`). Once npm is set up, it runs on merges to `main`: bump `version` in `package.json` in a PR, and merging it publishes to npm with provenance and tags the commit `v<version>` and `v<major>`.

npm trusted publishing (GitHub OIDC, no token) can only be set up for a package that already exists, so:

1. The first version is published with a short-lived npm token in the `NPM_TOKEN` repository secret.
2. On npmjs.com, the package's Settings → Trusted publisher is set to GitHub Actions, repository `soft-advisor/pulumi-affected`, workflow `publish.yml`.
3. The `NPM_TOKEN` secret is deleted and the token revoked.
