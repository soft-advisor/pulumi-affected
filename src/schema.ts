/** JSON Schema for pulumi-affected.yaml. `pnpm build` writes it to schema.json for editors. */
export const configSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/soft-advisor/pulumi-affected/blob/main/schema.json',
  title: 'pulumi-affected configuration',
  description:
    "Optional. Everything is detected automatically; use this file for what analysis can't see.",
  type: 'object',
  additionalProperties: false,
  definitions: {
    stackPatterns: {
      description:
        'Stack patterns: "<project>/<stack>", where <project> is the project\'s name or its folder, a bare "<stack>" for that stack in every project, globs such as "accounts/*", or "all".',
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    globs: {
      description: 'Repo-relative file globs',
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  properties: {
    $schema: { type: 'string' },
    projects: {
      description:
        'Which Pulumi projects to consider. By default every folder with a Pulumi.yaml, outside node_modules.',
      type: 'object',
      additionalProperties: false,
      properties: {
        include: { $ref: '#/definitions/globs' },
        exclude: { $ref: '#/definitions/globs' },
      },
    },
    stacks: {
      description: 'Stacks that have no Pulumi.<stack>.yaml file, as "<project>/<stack>"',
      type: 'array',
      items: { type: 'string', pattern: '^[A-Za-z0-9_./ @+-]+/[A-Za-z0-9_.-]+$' },
    },
    dependsOn: {
      description:
        "Dependencies analysis can't see, for example a stack that looks up another stack's resources in the cloud. Keys are stack patterns. Values are either stack patterns, whose outputs may all be read, or stack patterns mapped to the outputs that stand for what's read (only a change to those deploys or replans the dependent).",
      type: 'object',
      additionalProperties: {
        oneOf: [
          { $ref: '#/definitions/stackPatterns' },
          {
            type: 'object',
            additionalProperties: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
    },
    after: {
      description:
        "Order only: the key's stacks apply after these, when both are planned, without reading their outputs (dependsOn assumes every output is read). Keys and values are stack patterns.",
      type: 'object',
      additionalProperties: { $ref: '#/definitions/stackPatterns' },
    },
    rules: {
      description: 'Select stacks when files change in any way, even whitespace',
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['when', 'run'],
        properties: {
          when: { $ref: '#/definitions/globs' },
          run: { $ref: '#/definitions/stackPatterns' },
        },
      },
    },
    always: {
      description: 'Stacks selected on every run',
      $ref: '#/definitions/stackPatterns',
    },
    inputs: {
      description:
        "Files a stack reads that analysis can't find, such as an asset whose path is computed. Keys are stack patterns; a change to a matching file's content selects the stack.",
      type: 'object',
      additionalProperties: { $ref: '#/definitions/globs' },
    },
    globalInputs: {
      description:
        'Files whose content change selects every stack. Default: .nvmrc and .node-version.',
      $ref: '#/definitions/globs',
    },
    outputReaders: {
      description:
        "With plan's mode preview and apply's mode up: deploy the stacks that read outputs a deploy changed, after it and with the new values (up, the default), or only list them, to deploy later (warn)",
      enum: ['up', 'warn'],
    },
    createStacks: {
      description:
        "When stacks that don't exist yet are created. plan: the plan job creates them, empty, and plans them; apply: they must have no resources in the change that adds them, and the apply job creates them. The plan action's create-stacks input is the default; a Pulumi-Affected-Create-Stacks line in a pull request overrides both.",
      type: 'object',
      additionalProperties: false,
      properties: {
        default: { enum: ['plan', 'apply'] },
        plan: { description: 'Stacks created when planning', $ref: '#/definitions/stackPatterns' },
        apply: {
          description: 'Stacks created when applying',
          $ref: '#/definitions/stackPatterns',
        },
      },
    },
    classify: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ignore: {
          description:
            "Preview differences that aren't real changes, e.g. a provider's assumeRole when previews run with a read-only role. Only updates are ever ignored.",
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: {
                description: 'Resource type glob, e.g. pulumi:providers:aws',
                type: 'string',
              },
              properties: {
                description: "Top-level properties whose differences don't count; omit for all",
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    packages: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ignore: {
          description:
            'npm packages whose version changes never select a stack, as globs on the package name',
          $ref: '#/definitions/globs',
        },
      },
    },
  },
} as const;
