# Plan and apply, or preview and up

The `plan` and `apply` actions work in one of two modes. Both select the same stacks, preview them on the pull request, post one comment, and deploy in dependency order after merge. They differ in what's deployed.

|                                                | Plan and apply (strict)                                                            | Preview and up                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request                                   | `plan` with `mode: plan`: previews with `--save-plan`, keeps the plans             | `plan` with `mode: preview`: previews, keeps a list of which stacks had changes                                                                             |
| After merge                                    | `apply` with `mode: plan`: `pulumi up --plan` with exactly those plans             | `apply` with `mode: up`: `pulumi up` on the stacks with changes                                                                                             |
| What's deployed                                | Exactly what was reviewed, or nothing                                              | The merged code against the state as it is then                                                                                                             |
| If `main` or the cloud moved since the preview | The plan is refused; plan again                                                    | Deployed anyway, with the newer code and state                                                                                                              |
| Branch rules it relies on                      | Up-to-date branches, approvals ([guardrails](guardrails.md))                       | None                                                                                                                                                        |
| A stack reading outputs the change alters      | Can't be planned with the change; planned in a follow-up                           | Deployed after the stack it reads, with the new values (or listed, with `outputReaders: warn`)                                                              |
| New stacks                                     | Created when planning, or empty first with [`create-stacks: apply`](new-stacks.md) | Created when previewing (`create-stacks: plan`, the default), or by `up` (`create-stacks: apply`, previewed in a temporary backend, with no emptiness rule) |

Strict mode suits teams where several people merge and the approved plan must be the applied plan. Preview and up suits small teams, or repositories without branch rules: it's what a `preview` on pull requests and an `up` on `main` give you, with only the affected stacks. A repository can start with preview and up and switch to strict by changing the two `mode` inputs; the config and conventions stay the same.

## Preview and up

```yaml
# .github/workflows/plan.yml (pull requests)
- uses: soft-advisor/pulumi-affected/plan@v0
  with:
    mode: preview
```

```yaml
# .github/workflows/apply.yml (pushes to main)
- uses: soft-advisor/pulumi-affected/apply@v0
  with:
    mode: up
```

The rest of the workflows is as in the [example workflows](workflows.md) (sign-in, `fetch-depth: 0`, `actions: read` for `apply`).

**On the pull request,** `plan` selects the stacks the change affects and previews them, like strict mode, but keeps no plans. The comment shows each stack's changes. It uploads a small list of which stacks had changes and which had none, as the artifact `pulumi-previews-<pull request number>`.

**After merge,** `apply` works out again which stacks the merged change selects, from the commit itself. It skips the ones the pull request's preview found no changes in, and runs `pulumi up` on the rest, in dependency order. Stacks the change didn't select aren't touched. Without the list (the artifact expired, or the change wasn't previewed), it deploys every selected stack.

The list comes from the job that ran the pull request's code, so it's only used to skip: a stack it leaves out is deployed. A pull request could list a changed stack as unchanged, so that its code is merged without being deployed. That fails towards "not deployed", and in this mode the same author controls the code anyway.

**Stacks that read outputs.** When an `up` changes outputs that other stacks read (found from the code, or `dependsOn`; see [detection](detection.md)), those stacks are also deployed, after it, so they pick up the new values, even when the change didn't select them. The pull request's comment lists them as "also deployed after merging", and the result comment says why each was deployed. With `outputReaders: warn` (in `pulumi-affected.yaml`, or the `output-readers` input), they're only listed, to deploy later.

Their preview on the pull request, if they were previewed, used the outputs as they were before, so it can't show what the new values change.

**Trusting the list.** The preview's "no changes" only holds for the code it previewed. A stack that changed between the previewed commit and the merged one (because `main` moved on, or a deploy in between failed) is deployed anyway; if the previewed commit can't be found, nothing in the list is trusted.

**Reruns** run `up` again, which changes nothing for stacks already deployed. A rerun doesn't know which outputs the first run changed, so a stack reading them that failed the first time isn't deployed again by it; deploy it with `Pulumi-Affected-Run` or its force file.
