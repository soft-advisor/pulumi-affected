# pulumi-affected

Works out which Pulumi stacks a change affects, so CI plans only those. It follows what each stack's program actually runs, down to individual functions, instead of looking at which folders changed.

- A change to a shared function selects only the projects that call it.
- A dependency upgrade selects only the projects that load the package, directly or through other packages.
- Comments, formatting, types and docs select nothing.
- Stacks that read other stacks' outputs are ordered after them, in waves.

It works with TypeScript and JavaScript Pulumi programs, and npm, yarn (classic and berry) and pnpm. It needs no Pulumi Cloud features and works with any backend.

It comes as a CLI and four GitHub Actions: `select` (which stacks a change affects), `classify` (which previews would change anything), and the optional `plan` and `apply`, which preview the selected stacks with `--save-plan` on the pull request and later apply exactly those plans, without previewing again. When to apply, approvals and credentials stay in your workflow. See [Example workflows](#example-workflows).

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

A preview doesn't show **stack outputs alone** changing, so a stack whose only change is its outputs counts as unchanged here. The plan file does show them; `plan` reads them from there.

### `plan` (optional)

Selects like `select`, then previews each selected stack in parallel with `--save-plan`, keeps the plans that would change something, and writes them with a `manifest.json` to `directory`. Sign in to Pulumi and your cloud before it.

```yaml
- id: plan
  uses: soft-advisor/pulumi-affected/plan@<commit sha>
```

| Input                                                      | Default                                     |                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base`, `bases`, `run`, `skip`, `all`, `working-directory` |                                             | As for `select`. The checked-out code is what's planned                                                                                                                  |
| `directory`                                                | `pulumi-plans`                              | Where plans, previews, `manifest.json` and `comment.md` go                                                                                                               |
| `command`                                                  | `pulumi --cwd {dir} --stack {stack}`        | How to run Pulumi for a stack; placeholders `{dir}`, `{stack}`, `{project}`, `{id}`. Run without a shell, so a wrapper script that picks credentials per stack goes here |
| `concurrency`                                              | `4`                                         | Previews at once                                                                                                                                                         |
| `upload`                                                   | `true`                                      | Upload `directory` as the artifact `pulumi-plans-<git tree SHA>`. Turn off to store the plans yourself                                                                   |
| `retention-days`                                           | repository setting                          | For the artifact                                                                                                                                                         |
| `comment`                                                  | `true`                                      | Post the report on the pull request, updated in place on later runs. `comment.md` is written either way, for posting elsewhere                                           |
| `pull-request`, `github-token`                             | the triggering pull request, `github.token` | Where and as whom to comment                                                                                                                                             |

**Outputs:** `directory`, `artifact`, `tree`, `any`, `ids`, `failed`.

- A stack is kept when its plan would change a resource or a stack output, or when it's new.
- A selected stack that doesn't exist yet is **created, empty,** so Pulumi can plan it (with the secrets provider its config file names). Its passphrase encryption salt goes into the manifest, so `apply` works from a checkout where the salt isn't committed.
- **Stacks that read outputs a plan changes.** A plan is made with the outputs other stacks have at planning time, so a stack reading outputs that another plan in the same change alters can't be planned correctly until that one is applied. The plan file says which outputs change, and the code says which outputs each stack reads (`getOutput`, `requireOutput`, `outputs.name` and the like, with names worked out from literals, constants, templates and config). When the names can't be worked out, or the dependency comes from `dependsOn`, the stack is assumed to read every output.
  - **It has no changes of its own:** the plan comment opens with a warning to plan it again after this change is applied, and the action warns too. `apply` repeats it and lists it in `needs-plan`. Opening that follow-up is up to you.
  - **It has changes of its own:** planning **fails** for it, so the change can't be applied as one: its code would be merged with a plan made against old values. Change the stack it reads first, then this stack in a later pull request (which is planned against the real, applied outputs). To merge anyway, leave it out with `Pulumi-Affected-Skip: <stack>`; the report then says it has undeployed changes to plan after this is applied.
- A stack that fails to preview fails the action, after uploading and commenting. `apply` refuses a manifest with failures.
- For each plan, the manifest records the stack's **state fingerprint** (a hash of its exported resources) at planning time.

**What the artifact holds:** Pulumi's plan files and previews, which contain resource inputs and outputs (secrets stay encrypted). Anyone who can read the repository's artifacts can read them; set `upload: false` and store them yourself if that's too wide.

### `apply` (optional)

Applies the plans for **exactly the checked-out code**: `pulumi up --plan` per stack, in dependency order, with no new preview.

```yaml
- uses: actions/checkout@v4 # the merged commit
- uses: soft-advisor/pulumi-affected/apply@<commit sha>
```

- **Where the plans come from:** `directory`, if it already holds a `manifest.json` (you fetched them yourself); otherwise the artifact `pulumi-plans-<tree SHA of the checkout>`, from `run-id` or else the newest run of this repository (not a fork) that uploaded it. No plans for this tree means failure: plan this exact code first.
- **Checks before applying anything:** the manifest and every plan file's hash are valid, planning had no failures, the checkout's tree is the one planned, the checkout has nothing the commit doesn't (no modified or untracked files outside the plan directory, apart from encryption salts Pulumi writes), and each stack is one the commit defines and `stacks` allows.
- **Trusted inputs only:** the plans came from a job that ran the pull request's code, so the stacks, their order and the config are read from the commit, never from the manifest. Each plan file's hash is checked again right before it's applied.
- **Per stack:** the state fingerprint must still match the one planned from. If it doesn't, the stack's plan is **refused** (plan again) and stacks depending on it are **skipped**; unrelated stacks still apply. Pulumi's own stack lock keeps two updates from running at once.
- **Reruns are safe:** each update is tagged `pulumi-affected:<plan hash>`, and a plan found among the stack's last 25 updates is reported as `already-applied`, not applied twice.
- If an applied plan changes outputs that **other stacks** read, those stacks are listed in `needs-plan`, the report and a warning: plan them next.
- **Preview credentials that differ from deploy credentials:** see [below](#preview-and-deploy-roles).

**Inputs:** `directory`, `run-id`, `stacks` (patterns that may be applied; a plan for any other stack fails the apply), `working-directory`, `command`, `concurrency`, `comment` (default `true`: on the triggering pull request, `pull-request`, or the pull request the pushed commit came from), `pull-request`, `github-token` (needs `actions: read` to find the artifact, `pull-requests: write` to comment).
**Outputs:** `directory`, `result` (each stack's outcome: `applied`, `already-applied`, `refused`, `failed` or `skipped`), `needs-plan`, `failed`.

#### Preview and deploy roles

Previews should run with read-only credentials, and applies with deploy credentials. When a program passes the role to its provider (`new aws.Provider(..., { assumeRole: ... })`, chosen by an environment variable), the plan records the preview role as the provider's input, and Pulumi refuses to apply it with another role. List such properties under `classify.ignore`, with their names:

```yaml
classify:
  ignore:
    - type: pulumi:providers:aws
      properties: [assumeRoles] # assumeRole in @pulumi/aws before v7
```

`classify` then doesn't count the difference as a change, and `apply` leaves exactly those properties open in the plan, so any value is accepted for them; every other input is still held to the plan. Rules without `properties` never relax a plan. The apply report lists every property left open. Credentials that come from the environment (OIDC, `AWS_*` variables) need none of this.

Whether a change may be applied (approvals, who may trigger it, required checks) is for your workflow and repository rules to decide before this step runs; see [Guardrails](#guardrails-and-limitations).

## Example workflows

These are starting points; everything around the actions is yours to change. Previews run the pull request's code with read-only credentials; applies run only merged code.

### Plan on the pull request, apply exactly those plans after merge

```yaml
# .github/workflows/plan.yml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited] # edited: Pulumi-Affected-Run lines in the description
concurrency:
  group: plan-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write # the plan comment
  id-token: write # read-only cloud role for previews; see Guardrails
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      # your read-only Pulumi and cloud sign-in, and dependency install
      - uses: soft-advisor/pulumi-affected/plan@<commit sha>
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
  actions: read # to find and download the pull request's plans
  pull-requests: write # the apply comment
  id-token: write # deploy role
jobs:
  apply:
    runs-on: ubuntu-24.04
    environment: production # optional: a required reviewer, or branch restrictions
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      # your deploy-role Pulumi and cloud sign-in, and dependency install
      - uses: soft-advisor/pulumi-affected/apply@<commit sha>
```

`pull_request` runs check out the pull request merged into `main`. When `main` hasn't moved since, that's the tree a squash merge produces, so `apply` finds the plans by the tree. If `main` moved, the trees differ, and `apply` fails instead of planning again: re-run the plan (requiring branches to be up to date makes GitHub enforce this).

A checkout for `apply` must not gain files the commit doesn't have: dependency installs must only write ignored files (`node_modules/`, and for Yarn Berry its [recommended ignores](https://yarnpkg.com/getting-started/qa#which-files-should-be-gitignored)).

To plan more stacks on a pull request, add `Pulumi-Affected-Run: <patterns>` to its description (the `edited` trigger re-plans) or touch a force file.

### Keeping undeployed code from being missed

Selection compares with the base branch, so code merged but never deployed (a skipped stack, a refused or failed apply) isn't selected again by later changes. Pass `bases` with the commit each stack was last deployed from, which Pulumi records as `environment["git.head"]` in `pulumi stack history --json`, and every stack is compared with what it actually runs:

```yaml
- id: bases
  run: |
    # for each stack: pulumi stack history --json --page-size 1 | jq -r '.[0].environment["git.head"]'
    echo 'bases={"site/prod":"<sha>"}' >> "$GITHUB_OUTPUT"
- uses: soft-advisor/pulumi-affected/plan@<commit sha>
  with: { bases: '${{ steps.bases.outputs.bases }}' }
```

### Recovering from a refused or failed apply

`apply` never plans again by itself. Open a new pull request that forces the stacks concerned (touch `Pulumi.<stack>.force`, or a `Pulumi-Affected-Run` line in its description), review its plans, and merge it.

### Scheduled drift check

Plans only guard against **Pulumi state** changing between planning and applying. Changes made directly in the cloud (drift) aren't in the state until a refresh, so a plan can't see them. Run a scheduled check, daily or weekly:

```yaml
# .github/workflows/drift.yml
on:
  schedule: [{ cron: '0 6 * * 1-5' }]
  workflow_dispatch:
jobs:
  drift:
    runs-on: ubuntu-24.04
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      # your read-only Pulumi and cloud sign-in, and dependency install
      - id: select
        uses: soft-advisor/pulumi-affected/select@<commit sha>
        with: { all: true, base: HEAD }
      - name: Fail on drift or undeployed changes
        env: { STACKS: '${{ steps.select.outputs.stacks }}' }
        run: |
          status=0
          while read -r stack; do
            dir=$(jq -r '.dir | if . == "" then "." else . end' <<<"$stack")
            pulumi --cwd "$dir" --stack "$(jq -r .stack <<<"$stack")" preview --refresh --expect-no-changes || status=1
          done < <(jq -c '.[]' <<<"$STACKS")
          exit $status
```

It also catches anything selection missed. Fix drift through a pull request, or with `pulumi refresh` where the cloud is right.

## Guardrails and limitations

The actions plan and apply; your repository's rules decide what may be applied:

- **Applies only run reviewed code.** Require an approval to merge into the default branch, and dismiss approvals when new commits are pushed. What's applied is the reviewed code against the state that was planned. The plan comment itself comes from a job that ran the pull request's code, so it shows what that code reported; review the code, not just the comment.
- **Plans must not go stale.** Require branches to be up to date with the default branch before merging (or use a merge queue). Otherwise the merged tree can differ from the planned one, and `apply` finds no plans.
- **Make the plan a required check**, so a pull request can't merge with a failing preview.
- **One apply workflow at a time**: a `concurrency` group that isn't cancelled midway. On self-managed backends, set `PULUMI_SELF_MANAGED_STATE_LOCKING`.
- **Credentials by event.** Previews run the pull request's code, so they get read-only roles. Give the deploy role a trust policy that only accepts the default branch's push (or the branches you apply from), and never give a job that runs a pull request's code a way to obtain it. Hiding variables from a step isn't isolation: code running in a job can read anything the job can.
- **Applying from a pull request (before merge) isn't covered.** The actions apply after merge, or wherever your workflow calls `apply` with the planned code checked out; checks such as approvals belong in that workflow.
- **Drift in the cloud isn't guarded against**; see [the scheduled drift check](#scheduled-drift-check).
- **Type-only changes** select nothing, since they don't change what's deployed; run `tsc --noEmit` in CI to catch type errors before the next plan does.
- **ESC environments** change outside the repository; stacks importing them get a warning, and can be selected with `always`, a rule or `Pulumi-Affected-Run`.
- **Stacks that only exist in the backend** (no `Pulumi.<stack>.yaml`) need listing under `stacks`.

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
