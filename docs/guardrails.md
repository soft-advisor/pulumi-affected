# Guardrails and limitations

The actions plan and apply; your repository's rules decide what may be applied:

- **Applies only run reviewed code.** Require an approval to merge into the default branch, and dismiss approvals when new commits are pushed. What's applied is the reviewed code against the state that was planned. The plan comment itself comes from a job that ran the pull request's code, so it shows what that code reported; review the code, not just the comment.
- **Plans must not go stale.** Require branches to be up to date with the default branch before merging (or use a merge queue). Otherwise the merged tree can differ from the planned one, and `apply` finds no plans.
- **Make the plan a required check**, so a pull request can't merge with a failing preview.
- **One apply workflow at a time**: a `concurrency` group that isn't cancelled midway. On self-managed backends, set `PULUMI_SELF_MANAGED_STATE_LOCKING`.
- **Credentials by event.** Previews run the pull request's code, so they get read-only roles. Give the deploy role a trust policy that only accepts the default branch's push (or the branches you apply from), and never give a job that runs a pull request's code a way to obtain it. Hiding variables from a step isn't isolation: code running in a job can read anything the job can.
- **Applying before merge is up to your workflow.** `apply` works wherever the planned code is checked out, a pull request's branch included, Atlantis-style; the example applies after merge. Checks such as approvals, and who may trigger it, belong in that workflow.
- **Plan files are written by the pull request's code.** Besides the checks above, they carry Pulumi's per-resource random seeds, which some providers use for auto-naming; a pull request's author could choose those.
- **Drift in the cloud isn't guarded against**; see [the scheduled drift check](workflows.md#scheduled-drift-check).
- **Type-only changes** select nothing, since they don't change what's deployed; run `tsc --noEmit` in CI to catch type errors before the next plan does.
- **ESC environments** change outside the repository; stacks importing them get a warning, and can be selected with `always`, a rule or `Pulumi-Affected-Run`.
- **Stacks that only exist in the backend** (no `Pulumi.<stack>.yaml`) need listing under `stacks`.
