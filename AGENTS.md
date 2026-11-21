# AGENTS.md

Guidance for anyone changing this repo, human or agent. See [README.md](README.md).

- **Select the fewest stacks that are provably enough.** Over-selection is the noise this tool exists to remove, so every rule that adds a stack needs a reason; but a missed change is never acceptable, so every rule that skips one needs a test showing it's safe, and where analysis can't be sure it falls back to selecting, with a warning.
- **Selection only.** The tool says which stacks a change affects and, given previews, which would change. Running Pulumi, storing plans, commenting and deciding when to deploy belong to each user's workflow; the README shows examples.
- **Public, reusable package.** No organization-specific names, URLs or IDs in `src/`; take them as config with sensible defaults.
- **Analysis runs against snapshots, not the disk.** Read files through `Snapshot` (`src/snapshot.ts`), so the base revision is analysed exactly as it was.
- **Every reason is user-facing.** It appears in job summaries and PR comments; keep it short and specific, naming the file and the function or package.
- **The action runs the committed bundle.** Run `pnpm build` and commit `select/dist`, `classify/dist` and `schema.json` with any change to `src/`; CI fails otherwise.
- **Scenarios first.** A new detection rule gets a case in `test/` and, when it's about a realistic layout, a scenario in `e2e/scenarios.json` with fixtures in `e2e/fixtures`.
- **Readable code.** One statement per line, named checks with specific errors, descriptive names, named constants, and comments that explain why.
- **CI uses GitHub-hosted runners and GitHub's own actions,** pinned to commit SHAs.
- **Releases:** bump the version in the PR that should publish it. Breaking changes to the config, outputs or CLI need a major version.
- **No AI attribution in commits or PRs:** no `Co-Authored-By` trailers for AI tools, no "Generated with …" lines and no session links.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
