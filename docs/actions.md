# GitHub Actions

## `select`

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

## `classify`

```yaml
- id: classify
  uses: soft-advisor/pulumi-affected/classify@<commit sha>
  with:
    previews: plans/*.preview.json # what `pulumi preview --json` printed, one file per stack
```

**Outputs:** `changed` and `unchanged` (JSON arrays of the preview files), `any`. A preview counts as changed when a resource would be created, updated, replaced or deleted. Reads and unchanged resources don't count, and neither does known noise listed under `classify.ignore`, such as a provider whose `assumeRole` differs because previews use a read-only role. Output that a wrapper script prints before Pulumi's JSON is skipped.

A preview doesn't show **stack outputs alone** changing, so a stack whose only change is its outputs counts as unchanged here. The plan file does show them; `plan` reads them from there.

## `plan` (optional)

Selects like `select`, then previews each selected stack in parallel with `--save-plan`, keeps the plans that would change something, and writes them with a `manifest.json` to `directory`. Sign in to Pulumi and your cloud before it.

```yaml
- id: plan
  uses: soft-advisor/pulumi-affected/plan@<commit sha>
```

| Input                                                      | Default                                     |                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`, `bases`, `run`, `skip`, `all`, `working-directory` |                                             | As for `select`. The checked-out code is what's planned                                                                                                                                                   |
| `directory`                                                | `pulumi-plans`                              | Where plans, previews, `manifest.json` and `comment.md` go                                                                                                                                                |
| `command`                                                  | `pulumi --cwd {dir} --stack {stack}`        | How to run Pulumi for a stack; placeholders `{dir}`, `{stack}`, `{project}`, `{id}`. Run without a shell, so a wrapper script that picks credentials per stack goes here                                  |
| `concurrency`                                              | `4`                                         | Previews at once, wave by wave, so a stack created to be planned exists before the stacks that read it                                                                                                    |
| `fail-fast`                                                | `false`                                     | Stop at the first stack that fails to plan, instead of planning the others and failing at the end                                                                                                         |
| `create-stacks`                                            | `plan`                                      | When a selected stack that doesn't exist yet is created: `plan` (now, empty, then planned) or `apply` (by `apply`; it must have no resources in the change that adds it). See [new stacks](new-stacks.md) |
| `upload`                                                   | `true`                                      | Upload `directory` as the artifact `pulumi-plans-<git tree SHA>`. Turn off to store the plans yourself                                                                                                    |
| `retention-days`                                           | repository setting                          | For the artifact                                                                                                                                                                                          |
| `comment`                                                  | `true`                                      | Post the report on the pull request, updated in place on later runs. `comment.md` is written either way, for posting elsewhere                                                                            |
| `pull-request`, `github-token`                             | the triggering pull request, `github.token` | Where and as whom to comment                                                                                                                                                                              |

**Outputs:** `directory`, `artifact`, `tree`, `any`, `ids`, `failed`.

- A stack is kept when its plan would change a resource or a stack output, or when it's new.
- A selected stack that doesn't exist yet is created when planning or when applying, depending on `create-stacks`, the config and the pull request; see [new stacks](new-stacks.md).
- **Stacks that read outputs a plan changes.** A plan is made with the outputs other stacks have at planning time, so a stack reading outputs that another plan in the same change alters can't be planned correctly until that one is applied. The plan file says which outputs change, and the code says which outputs each stack reads (`getOutput`, `requireOutput`, `outputs.name` and the like). Names are worked out from literals, constants, templates and config, and the reference is followed through the whole program with TypeScript's language service, resolving imports exactly as the rest of the analysis does: exported and imported, passed to functions, or read through helpers whose output-name parameter every call passes a known name. Types are never trusted for names, since a cast or `any` can make them say anything. When the names can't be worked out (or a module is loaded with `require()`/`import()`, or the analysis runs out of time), or the dependency comes from `dependsOn`, the stack is assumed to read every output. Outputs whose new value is only known once applied count as changed, reported as "may change".
  - Only JavaScript and TypeScript programs are analysed for stack references. When outputs change and stacks of other runtimes (or with stack names that can't be worked out) may read them, the plan and apply warn; declare what they read under `dependsOn`.
  - A chain is caught one step at a time: if A's outputs change and B reads them and passes them on to C, B is the follow-up, and C becomes one once B's new plan changes B's outputs.
  - **It has no changes of its own:** the plan comment opens with a warning to plan it again after this change is applied, and the action warns too. `apply` repeats it and lists it in `needs-plan`. Opening that follow-up is up to you.
  - **It has changes of its own:** planning **fails** for it, so the change can't be applied as one: its code would be merged with a plan made against old values. Change the stack it reads first, then this stack in a later pull request (which is planned against the real, applied outputs). To merge anyway, leave it out with `Pulumi-Affected-Skip: <stack>`; the report then says it has undeployed changes to plan after this is applied.
- A stack that fails to preview fails the action, after uploading and commenting. `apply` refuses a manifest with failures.
- For each plan, the manifest records the stack's **state fingerprint** (a hash of its exported resources) at planning time.

**What the artifact holds:** Pulumi's plan files and previews, which contain resource inputs and outputs (secrets stay encrypted). Anyone who can read the repository's artifacts can read them; set `upload: false` and store them yourself if that's too wide.

## `apply` (optional)

Applies the plans for **exactly the checked-out code**: `pulumi up --plan` per stack, in dependency order, with no new preview.

```yaml
- uses: actions/checkout@v4 # the merged commit
- uses: soft-advisor/pulumi-affected/apply@<commit sha>
```

- **Where the plans come from:** `directory`, if it already holds a `manifest.json` (you fetched them yourself); otherwise the artifact `pulumi-plans-<tree SHA of the checkout>`, downloaded to the runner's temporary folder, from `run-id` or else the newest run that uploaded it. The run must be of this repository (not a fork) and must have run on the head commit of the pull request this commit came from (or on this commit, or `plan-sha`): a run on another branch can't supply plans, even for the same code. No plans means failure: plan this exact code first.
- **Checks before applying anything:** the manifest and every plan file's hash are valid, planning had no failures, the checkout's tree is the one planned, the checkout has nothing the commit doesn't (no modified or untracked files outside the plan directory, apart from encryption salts Pulumi writes), and each stack is one the commit defines and `stacks` allows.
- **Trusted inputs only:** the plans came from a job that ran the pull request's code, so the stacks, their order, the config and which outputs each plan changes are read from the commit and the plan files, never from the manifest. Which stacks the change selects is worked out again (from the event's base or `base`, the pull request's `Pulumi-Affected-Run`/`Skip` lines, and the `run`/`skip`/`all`/`bases` inputs, which should match the plan's), and a plan for any other stack fails the apply. Each plan file's hash is checked again right before it's applied. What apply can't check is that every stack that should have a plan has one: a stack previewed without changes legitimately has none.
- **Per stack:** the state fingerprint must still match the one planned from. If it doesn't, the stack's plan is **refused** (plan again) and stacks depending on it are **skipped**; unrelated stacks still apply. Pulumi's own stack lock keeps two updates from running at once.
- **Reruns are safe:** each update is tagged `pulumi-affected:<plan hash>:<tree>`, and a plan found among the stack's last 25 updates is reported as `already-applied`, not applied twice.
- If an applied plan changes outputs that **other stacks** read, those stacks are listed in `needs-plan`, the report and a warning: plan them next.
- **Preview credentials that differ from deploy credentials:** see [below](#preview-and-deploy-roles).

**Inputs:** `directory`, `run-id`, `plan-sha`, `base`, `bases`, `run`, `skip`, `all` (as given to `plan`), `stacks` (patterns that may be applied; a plan for any other stack fails the apply), `working-directory`, `command`, `concurrency`, `fail-fast` (stop at the first stack that isn't applied), `comment` (default `true`: on the triggering pull request, `pull-request`, or the pull request the pushed commit came from), `pull-request`, `github-token` (needs `actions: read` to find the artifact, `pull-requests: write` to comment).
**Outputs:** `directory`, `result` (each stack's outcome: `applied`, `already-applied`, `refused`, `failed` or `skipped`), `needs-plan`, `failed`.

### Preview and deploy roles

Previews should run with read-only credentials, and applies with deploy credentials. When a program passes the role to its provider (`new aws.Provider(..., { assumeRole: ... })`, chosen by an environment variable), the plan records the preview role as the provider's input, and Pulumi refuses to apply it with another role. List such properties under `classify.ignore`, with their names:

```yaml
classify:
  ignore:
    - type: pulumi:providers:aws
      properties: [assumeRoles] # assumeRole in @pulumi/aws before v7
```

`classify` then doesn't count the difference as a change, and `apply` leaves exactly those properties open in the plan, so any value is accepted for them; every other input is still held to the plan. Rules without `properties` never relax a plan. The apply report lists every property left open. Credentials that come from the environment (OIDC, `AWS_*` variables) need none of this.

Whether a change may be applied (approvals, who may trigger it, required checks) is for your workflow and repository rules to decide before this step runs; see [Guardrails](guardrails.md).
