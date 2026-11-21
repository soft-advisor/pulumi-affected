# AGENTS.md

Guidance for anyone changing this repo, human or agent. See [README.md](README.md) and [docs](docs/); keep the README lean and put details in docs.

- **Select the fewest stacks that are provably enough.** Over-selection is the noise this tool exists to remove, so every rule that adds a stack needs a reason; but a missed change is never acceptable, so every rule that skips one needs a test showing it's safe, and where analysis can't be sure it falls back to selecting, with a warning.
- **Select, plan and apply; never orchestrate.** The tool says which stacks a change affects and, given previews, which would change. The optional `plan` and `apply` actions make plans and apply exactly those, refusing anything they can't prove is what was planned (another tree, changed state, a tampered manifest). When to apply, approvals, triggers and credentials belong to each user's workflow; make behaviour configurable rather than deciding policy.
- **Public, reusable package.** No organization-specific names, URLs or IDs in `src/`; take them as config with sensible defaults.
- **Analysis runs against snapshots, not the disk.** Read files through `Snapshot` (`src/snapshot.ts`), so the base revision is analysed exactly as it was.
- **Every reason is user-facing.** It appears in job summaries and PR comments; keep it short and specific, naming the file and the function or package.
- **The actions and npm get the committed build.** Run `pnpm build` and commit `dist`, `select/dist`, `classify/dist`, `plan/dist`, `apply/dist` and `schema.json` with any change to `src/`; CI fails otherwise. npm gets exactly the committed `dist`.
- **Scenarios first.** A new detection rule gets a case in `test/` and, when it's about a realistic layout, a scenario in `e2e/scenarios.json` with fixtures in `e2e/fixtures`.
- **Readable code.** One statement per line, named checks with specific errors, descriptive names, named constants, and comments that explain why.
- **CI uses GitHub-hosted runners and GitHub's own actions,** pinned to commit SHAs.
- **Releases:** bump the version in the PR that should publish it. Breaking changes to the config, outputs or CLI need a major version.
- **No AI attribution in commits or PRs:** no `Co-Authored-By` trailers for AI tools, no "Generated with …" lines and no session links.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
