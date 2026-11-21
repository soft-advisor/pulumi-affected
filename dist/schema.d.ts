/** JSON Schema for pulumi-affected.yaml. `pnpm build` writes it to schema.json for editors. */
export declare const configSchema: {
    readonly $schema: "http://json-schema.org/draft-07/schema#";
    readonly $id: "https://github.com/soft-advisor/pulumi-affected/blob/main/schema.json";
    readonly title: "pulumi-affected configuration";
    readonly description: "Optional. Everything is detected automatically; use this file for what analysis can't see.";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly definitions: {
        readonly stackPatterns: {
            readonly description: "Stack patterns: \"<project>/<stack>\", where <project> is the project's name or its folder, a bare \"<stack>\" for that stack in every project, globs such as \"accounts/*\", or \"all\".";
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
            };
        };
        readonly globs: {
            readonly description: "Repo-relative file globs";
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
            };
        };
    };
    readonly properties: {
        readonly $schema: {
            readonly type: "string";
        };
        readonly projects: {
            readonly description: "Which Pulumi projects to consider. By default every folder with a Pulumi.yaml, outside node_modules.";
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly include: {
                    readonly $ref: "#/definitions/globs";
                };
                readonly exclude: {
                    readonly $ref: "#/definitions/globs";
                };
            };
        };
        readonly stacks: {
            readonly description: "Stacks that have no Pulumi.<stack>.yaml file, as \"<project>/<stack>\"";
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly pattern: "^[A-Za-z0-9_./ @+-]+/[A-Za-z0-9_.-]+$";
            };
        };
        readonly dependsOn: {
            readonly description: "Dependencies analysis can't see, for example a stack that looks up another stack's resources in the cloud. Keys and values are stack patterns.";
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/stackPatterns";
            };
        };
        readonly rules: {
            readonly description: "Select stacks when files change in any way, even whitespace";
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["when", "run"];
                readonly properties: {
                    readonly when: {
                        readonly $ref: "#/definitions/globs";
                    };
                    readonly run: {
                        readonly $ref: "#/definitions/stackPatterns";
                    };
                };
            };
        };
        readonly always: {
            readonly description: "Stacks selected on every run";
            readonly $ref: "#/definitions/stackPatterns";
        };
        readonly inputs: {
            readonly description: "Files a stack reads that analysis can't find, such as an asset whose path is computed. Keys are stack patterns; a change to a matching file's content selects the stack.";
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/globs";
            };
        };
        readonly globalInputs: {
            readonly description: "Files whose content change selects every stack. Default: .nvmrc and .node-version.";
            readonly $ref: "#/definitions/globs";
        };
        readonly classify: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly ignore: {
                    readonly description: "Preview differences that aren't real changes, e.g. a provider's assumeRole when previews run with a read-only role. Only updates are ever ignored.";
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly required: readonly ["type"];
                        readonly properties: {
                            readonly type: {
                                readonly description: "Resource type glob, e.g. pulumi:providers:aws";
                                readonly type: "string";
                            };
                            readonly properties: {
                                readonly description: "Top-level properties whose differences don't count; omit for all";
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly packages: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly ignore: {
                    readonly description: "npm packages whose version changes never select a stack, as globs on the package name";
                    readonly $ref: "#/definitions/globs";
                };
            };
        };
    };
};
