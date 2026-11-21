# Development

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

Bump `version` in `package.json` in a PR. Merging it runs [`publish.yml`](../.github/workflows/publish.yml): once CI has passed on the commit, it publishes to npm with provenance, signing in with the workflow's own OIDC token (npm trusted publishing: repository `soft-advisor/pulumi-affected`, workflow `publish.yml`, environment `release`), so no npm token is stored. The commit is tagged `v<version>`, and `v<major>` moves to it.

What's published is exactly the committed files: the built `dist/` is committed like the action bundles, CI checks it matches the source, and the publish job only checks out, packs and publishes, with no install and no lifecycle scripts. So a compromised dev dependency can't change the package without that showing in a reviewed diff.

If npm holds a release for approval (staged publishing), approve it on npmjs.com; the tags move on the next run of the workflow (any merge, or running it by hand), so actions pinned to `v<major>` never get a release npm hasn't let out.
