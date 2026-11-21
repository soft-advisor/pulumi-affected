# New stacks

Pulumi can only plan for a stack that exists. When a change adds a stack (a new `Pulumi.<stack>.yaml`, or a new project), something has to create it, and that can happen in one of two places:

|                                             | `plan` (the default)                          | `apply`                                                                             |
| ------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Who creates the stack                       | The plan job, on the pull request             | The apply job, after merge                                                          |
| What the first change may contain           | Anything: the stack is planned like any other | No resources: the change that adds the stack leaves it empty                        |
| Pull requests to get a stack with resources | One                                           | Two: one adds the stack, the next its resources                                     |
| Credentials the plan job needs              | Permission to create stacks in the backend    | Read only                                                                           |
| Backends                                    | Any                                           | Any, with [limits](#limits) when the first change has secrets or reads other stacks |
| An abandoned pull request leaves            | An empty stack behind                         | Nothing                                                                             |

Choose `plan` when the plan job can create stacks: it's simpler. Choose `apply` when previews must stay read-only, for example when the plan job's role may only write Pulumi's lock files.

## `create-stacks: plan`

The plan job runs `pulumi stack init` (with the secrets provider the stack's config file names), then plans the empty stack like any other: every resource shows as a create, and the plan is applied after merge like every other plan.

Pulumi writes a passphrase stack's encryption salt into the plan job's copy of `Pulumi.<stack>.yaml`. The plan's secrets are encrypted with it, so the salt goes into the manifest, and `apply` writes it back into its checkout when the committed file doesn't have one. Commit the salt when you can; nothing depends on it.

## `create-stacks: apply`

The plan job can't create the stack, so it can't plan its resources either. Instead, the change that adds a stack must give it **no resources**, and its resources come in a later change, planned against the real stack.

1. **Plan.** The stack is previewed in a temporary local backend on the runner, never in the real one. If the preview would create any resource, planning fails for that stack:

   > It doesn't exist yet, and it's created when applying (create-stacks: apply), so the change that adds it must give it no resources; this one would create 3: aws:s3/bucket:Bucket site, …

   If it creates nothing, that (empty) plan is kept, and the plan comment shows the stack as "new stack, created empty when applied".
2. **Apply.** After merge, `apply` checks the plan really creates nothing but the stack (the manifest comes from the plan job, so it isn't taken on trust), then runs `pulumi stack init` and `pulumi up --plan` with the empty plan. Pulumi refuses to create anything the plan doesn't have, so the stack can't get resources here even if the code changed. Code and state agree: the stack exists, with nothing in it (and any outputs the program exports).
3. **The next change** adds the resources. It selects the stack like any change to its code, and plans it against the real, existing stack: its real secrets provider, the real stacks it references, the real organization.

### Making a program empty for a new stack

Most programs create the same resources for every stack. To add a stack before its resources, the program has to create nothing for it yet. Common ways:

- **A new project:** its first change is a `Pulumi.yaml`, a `Pulumi.<stack>.yaml` and an entry file that exports nothing, or only constants.
- **A new stack of an existing project:** gate the resources on config the new stack doesn't have yet, for example `if (config.getBoolean('enabled')) { … }`, and set `enabled: true` in its config in the next change.

### The temporary backend

The preview runs your `command` template with `PULUMI_BACKEND_URL` pointing at a folder on the runner, which is deleted afterwards. Your wrapper script must leave that variable as it's given. Before creating anything, `pulumi about` is run through the template, and the backend it reports must be that folder; otherwise planning fails without having touched the real backend.

The temporary stack always uses passphrase secrets, whatever its config file names. If the stack really uses passphrase secrets and `PULUMI_CONFIG_PASSPHRASE` is set, the salt the temporary stack got is recorded in the manifest, and `apply` creates the real stack with it, so any secrets in the plan (a `pulumi.secret(...)` output, a secret read from another stack) decrypt. Otherwise a throwaway passphrase is used, and a plan that holds any secret fails planning, since nothing could decrypt it when applying.

The stacks the new stack references (from the dependency analysis and `dependsOn`) are copied into the temporary backend first, with `pulumi stack export` from the real backend and `pulumi stack import`, so a program that reads them at the top level previews as it will run. Copying needs read access to those stacks, which the plan job has. Their secrets stay encrypted as they are. A referenced stack that doesn't exist yet either is skipped; any other export error fails planning.

The config files Pulumi writes encryption salts into while doing this are restored afterwards, so the checkout is left as it was. New stacks are previewed one at a time, since two of them can reference the same stack.

### Limits

The temporary backend is a self-managed backend with passphrase secrets. For a program with no resources that rarely matters, but:

- **Secrets in the first change** only carry over with passphrase secrets and `PULUMI_CONFIG_PASSPHRASE` set (above). With Pulumi Cloud's own secrets or a cloud KMS, a first change whose plan holds a secret fails planning.
- **Reading other stacks on Pulumi Cloud:** a stack reference names a real organization (`acme/network/prod`), which a local backend doesn't have, and stacks using Pulumi Cloud's secrets can't be read outside it, so a new stack that reads another stack at the top level can't be previewed there.
- **`pulumi.getOrganization()`** returns `organization` instead of the real one.
- **References analysis can't see** (stacks outside the repository, names it can't work out, and no `dependsOn`) aren't copied in, so reading them fails the preview.

Planning then fails with an explanation or Pulumi's error. Create such a stack when planning instead; see [choosing per stack or per change](#choosing-per-stack-or-per-change).

### Encryption salts

When `apply` creates a passphrase stack, Pulumi writes its encryption salt into the apply job's copy of `Pulumi.<stack>.yaml`, not into git. Pulumi only reads the salt from that file: without it, a later run makes a new salt, and the stack's secrets no longer decrypt. So both `plan` and `apply` write the salt recorded in the stack's state into any checkout whose config file has none (after checking it's a well-formed salt). Committing the salt is still the tidy option.

## Choosing per stack or per change

The setting comes from, in order (the first that applies wins):

1. **The pull request or a commit message:** a `Pulumi-Affected-Create-Stacks` line, for every new stack or for some:

   ```
   Pulumi-Affected-Create-Stacks: plan
   Pulumi-Affected-Create-Stacks: plan accounts/newco, site/*
   ```

   When several lines name a stack, the last one counts: commits from oldest to newest, then the pull request description. A malformed line is reported as a warning. The plan workflow should run on `edited` pull requests for a description change to take effect.
2. **The config,** `pulumi-affected.yaml`: patterns per mode, and a default:

   ```yaml
   createStacks:
     default: apply # instead of the action's input
     plan: [accounts/*] # these are created when planning (checked first)
     apply: [site/*]
   ```
3. **The plan action's `create-stacks` input** (default `plan`).

Overriding is safe: what the plan job may do is decided by its credentials, not by this setting. A pull request that asks for `plan` while the plan job is read-only only gets a planning error.
