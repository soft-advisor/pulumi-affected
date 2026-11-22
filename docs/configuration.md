# Configuration

Optional: `pulumi-affected.yaml` at the repository root. The [schema](../schema.json) gives editors completion.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/soft-advisor/pulumi-affected/main/schema.json
projects:
  include: ['**'] # folders with a Pulumi.yaml to consider
  exclude: ['examples/**']
stacks: [site/preview] # stacks without a Pulumi.<stack>.yaml
dependsOn: # dependencies analysis can't see, e.g. cloud lookups
  site/prod: [site/dev] # prod may read any of dev's outputs
  site/preview:
    site/dev: [nameServers] # only a change to dev's nameServers affects it
after: # order only: applied after these when both are planned, reading none of their outputs
  accounts/*: [org/prod, accounts/management]
rules:
  - when: ['scripts/pulumi.sh']
    run: [all]
always: [accounts/management]
inputs:
  lambdas/*: ['lambdas/src/**'] # files read from computed paths
globalInputs: ['.nvmrc', '.node-version'] # the default
packages:
  ignore: ['@types/*']
outputReaders: up # preview and up: deploy stacks reading changed outputs after them (or warn); see modes.md
createStacks: # when stacks that don't exist yet are created; see new-stacks.md
  default: plan
  apply: [site/*]
classify:
  ignore: # preview differences that aren't real changes
    - type: pulumi:providers:aws
      properties: [assumeRole, assumeRoles] # previews run with a read-only role
```

Patterns in `dependsOn`, `after` and `createStacks` that match no stack are reported as warnings, as are outputs named under `dependsOn` that the stack doesn't export (checked when previewing and deploying, against its outputs and the ones its plan adds): either would otherwise quietly do nothing.
