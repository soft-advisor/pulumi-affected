# Example workflows

These are starting points; everything around the actions is yours to change. Previews run the pull request's code with read-only credentials; applies run only merged code.

## Plan on the pull request, apply exactly those plans after merge

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
        with: { fetch-depth: 0, persist-credentials: false }
      # your deploy-role Pulumi and cloud sign-in, and dependency install
      - uses: soft-advisor/pulumi-affected/apply@<commit sha>
```

`pull_request` runs check out the pull request merged into `main`. When `main` hasn't moved since, that's the tree a squash merge produces, so `apply` finds the plans by the tree. If `main` moved, the trees differ, and `apply` fails instead of planning again: re-run the plan (requiring branches to be up to date makes GitHub enforce this).

A checkout for `apply` must not gain files the commit doesn't have: dependency installs must only write ignored files (`node_modules/`, and for Yarn Berry its [recommended ignores](https://yarnpkg.com/getting-started/qa#which-files-should-be-gitignored)).

To plan more stacks on a pull request, add `Pulumi-Affected-Run: <patterns>` to its description (the `edited` trigger re-plans) or touch a force file.

## Keeping undeployed code from being missed

Selection compares with the base branch, so code merged but never deployed (a skipped stack, a refused or failed apply) isn't selected again by later changes. Pass `bases` with the commit each stack was last deployed from, which Pulumi records as `environment["git.head"]` in `pulumi stack history --json`, and every stack is compared with what it actually runs:

```yaml
- id: bases
  run: |
    # for each stack: pulumi stack history --json --page-size 1 | jq -r '.[0].environment["git.head"]'
    echo 'bases={"site/prod":"<sha>"}' >> "$GITHUB_OUTPUT"
- uses: soft-advisor/pulumi-affected/plan@<commit sha>
  with: { bases: '${{ steps.bases.outputs.bases }}' }
```

## Recovering from a refused or failed apply

`apply` never plans again by itself. Open a new pull request that forces the stacks concerned (touch `Pulumi.<stack>.force`, or a `Pulumi-Affected-Run` line in its description), review its plans, and merge it.

## Scheduled drift check

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
