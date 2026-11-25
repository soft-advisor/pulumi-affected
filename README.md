# pulumi-affected

Works out which Pulumi stacks a change affects, so CI plans only those. It follows what each stack's program actually runs, down to individual functions, instead of looking at which folders changed.

- A change to a shared function selects only the projects that call it.
- A dependency upgrade selects only the projects that load the package, directly or through other packages.
- Comments, formatting, types and docs select nothing.
- Stacks that read other stacks' outputs are ordered after them, in waves.

It works with TypeScript and JavaScript Pulumi programs, and npm, yarn (classic and berry) and pnpm. It needs no Pulumi Cloud features and works with any backend.

It comes as a CLI and four GitHub Actions: `select` (which stacks a change affects), `classify` (which previews would change anything), and the optional `plan` and `apply`, which preview the selected stacks with `--save-plan` on the pull request and later apply exactly those plans, without previewing again. When to apply, approvals and credentials stay in your workflow.

## Quick start

Plan on the pull request:

```yaml
# .github/workflows/plan.yml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
permissions: { contents: read, pull-requests: write, id-token: write }
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      # your read-only Pulumi and cloud sign-in, and dependency install
      - uses: soft-advisor/pulumi-affected/plan@v0
```

Apply exactly those plans after merge:

```yaml
# .github/workflows/apply.yml
on:
  push:
    branches: [main]
concurrency: { group: apply, cancel-in-progress: false }
permissions: { contents: read, actions: read, pull-requests: write, id-token: write }
jobs:
  apply:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      # your deploy-role Pulumi and cloud sign-in, and dependency install
      - uses: soft-advisor/pulumi-affected/apply@v0
```

This is the strict mode: the merge applies exactly the plans reviewed. For a preview on the pull request and a `pulumi up` after merge instead, set `mode: preview` and `mode: up`; see [modes](docs/modes.md).

Pin the actions to a commit SHA in production. Read [Guardrails](docs/guardrails.md) before relying on this: your repository's rules (approvals, up-to-date branches) are what make plans safe to apply.

## Forcing a stack

| How                                                                      | Example                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Touch a force file next to the stack's config: any edit, even whitespace | `accounts/Pulumi.business.force`, or `accounts/Pulumi.force` for every stack of the project                                                 |
| A line in a commit message or the pull request description               | `Pulumi-Affected-Run: dns/prod, accounts/*` (or `all`)                                                                                      |
| Config                                                                   | `rules`, `always` ([configuration](docs/configuration.md))                                                                                  |
| CLI / action input                                                       | `--run dns/prod`, `--all`; a workflow can fill the `run` input from anything, such as a `workflow_dispatch` input or a pull request comment |

`Pulumi-Affected-Skip: <patterns>` leaves stacks out, unless something also requests them. Skipped stacks are listed in the output with what skipped them, so a skip is never silent.

Forcing selects a stack, but in [mode `up`](docs/modes.md) a selected stack whose preview shows no changes still isn't deployed. To deploy it anyway, use `Pulumi-Affected-Force-Up: <patterns>` (or the `force-up` input, `--force-up`): it selects the stacks and `apply` runs `pulumi up` on them even without changes. That's for changes Pulumi doesn't preview, such as `protect`, which only takes effect once `up` records it. Mode `plan` refuses it, since a stack without changes has no plan to apply.

Stack patterns are `<project>/<stack>`, where `<project>` is the project's name or its folder, or a bare `<stack>` for that stack in every project. Both parts may be globs.

## Documentation

|                                                    |                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [How detection works](docs/detection.md)           | What selects a stack: code, packages, config, files read, stack references; forcing and skipping |
| [Configuration](docs/configuration.md)             | `pulumi-affected.yaml`                                                                           |
| [GitHub Actions](docs/actions.md)                  | `select`, `classify`, `plan` and `apply`: inputs, outputs and what each checks                   |
| [Example workflows](docs/workflows.md)             | Plan and apply, keeping undeployed code from being missed, recovering, drift checks              |
| [Plan and apply, or preview and up](docs/modes.md) | Applying exactly the reviewed plans, or previewing and deploying with `pulumi up`                |
| [New stacks](docs/new-stacks.md)                   | Creating stacks when planning or when applying                                                   |
| [Guardrails and limitations](docs/guardrails.md)   | What your repository must enforce, and what isn't covered                                        |
| [Development and releasing](docs/development.md)   | Working on this repository                                                                       |

## CLI

```sh
npx @soft-advisor/pulumi-affected select --base origin/main [--format markdown]
npx @soft-advisor/pulumi-affected dependents accounts/business [--transitive]
pulumi preview --json | npx @soft-advisor/pulumi-affected classify
```

`select` analyses the working tree unless `--head` is given. `classify` exits 0 when the preview changes something and 3 when it doesn't. See `--help` for every option.
