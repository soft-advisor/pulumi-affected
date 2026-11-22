import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planStacks } from "../plan/plan.js";
import { COMMENT_FILE } from "../plan/manifest.js";
import { describeRead } from "../plan/outputs.js";
import { renderPlan } from "../plan/report.js";
import { commandRunner, DEFAULT_COMMAND } from "../pulumi/runner.js";
import { repoRootOf } from "../snapshot.js";
import { marker, postReport } from "./comments.js";
import { ensureCurrentMerge } from "./merge.js";
import { appendSummary, booleanInput, error, GitHubApi, input, notice, printUntrusted, readEvent, setOutput, warning, } from "./github.js";
import { choice, outputReaders, positiveInteger, pullRequestNumber, selectOptionsFromInputs, } from "./inputs.js";
/*
 * The `plan` action's Node step: selects, previews each selected stack with --save-plan and
 * writes the plans, their manifest and a report. The composite action around it uploads the
 * directory and fails the job when a stack failed, after the upload and comment.
 */
async function main() {
    // A run right after the base changed may have GitHub's merge into the old base
    const token = input('github-token');
    let merge = { kind: 'current' };
    if (!input('base') && token) {
        const repoRoot = repoRootOf(input('working-directory') || process.cwd());
        merge = await ensureCurrentMerge(repoRoot, readEvent(), new GitHubApi(token), token);
        if (merge.kind === 'refreshed')
            notice(`Checked out GitHub's updated merge, ${merge.sha}`);
    }
    const { options, event } = selectOptionsFromInputs();
    // Plans are for the checked-out code, which is what Pulumi previews
    const { head: _, ...select } = options;
    const directory = resolve(input('directory') || 'pulumi-plans');
    const repoRoot = repoRootOf(options.cwd);
    const runner = commandRunner(input('command') || DEFAULT_COMMAND, repoRoot);
    const mode = choice('mode', ['plan', 'preview'], 'plan');
    const readers = outputReaders(repoRoot);
    const manifest = await planStacks({
        select,
        directory,
        runner,
        concurrency: positiveInteger('concurrency', 4),
        failFast: booleanInput('fail-fast'),
        createStacks: createStacksInput(),
        mode,
        onFinish: (outcome) => {
            if (outcome.kind === 'failed')
                printUntrusted(`${outcome.id}: failed\n${outcome.error}`);
            else
                console.log(`${outcome.kind === 'planned' ? outcome.stack.id : outcome.id}: ${outcome.kind}`);
        },
    });
    if (merge.kind === 'stale') {
        manifest.warnings.push("This was previewed against an outdated base: GitHub hadn't updated the pull request's merge after its base changed. Run it again.");
    }
    for (const message of manifest.warnings)
        warning(message);
    const deployedAfter = mode === 'preview' && readers === 'up';
    for (const read of manifest.followUps) {
        warning(`${deployedAfter ? `${read.id} is also deployed after merging` : `Plan ${read.id} again after this is applied`}: it ${describeRead(read)}`);
    }
    const report = renderPlan(manifest, (index) => marker('plan', index), readers);
    writeFileSync(join(directory, COMMENT_FILE), report.bodies.join('\n\n'));
    appendSummary(report.summary);
    setOutput('directory', directory);
    // Previews are found by the pull request they're for; plans by the exact code they're for
    setOutput('artifact', mode === 'preview'
        ? `pulumi-previews-${pullRequestNumber(event) ?? manifest.head}`
        : `pulumi-plans-${manifest.tree}`);
    setOutput('tree', manifest.tree);
    setOutput('any', manifest.stacks.length > 0 ? 'true' : 'false');
    setOutput('ids', JSON.stringify(manifest.stacks.map((stack) => stack.id)));
    setOutput('failed', manifest.failed.length > 0 ? 'true' : 'false');
    if (booleanInput('comment')) {
        const number = pullRequestNumber(event);
        if (number === undefined)
            notice('Not a pull request run, so the plan isn’t commented; set pull-request');
        else if (!token)
            warning('No github-token, so the plan isn’t commented');
        else {
            // The plans matter more than the comment: a failure here mustn't stop their upload
            try {
                const api = new GitHubApi(token);
                const sha = await headOf(api, number, event);
                const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
                await postReport(api, number, 'plan', report.bodies, {
                    verb: mode === 'preview' ? 'Previewed' : 'Planned',
                    sha,
                    url: `${server}/${api.repository}/pull/${number}/commits/${sha}`,
                });
            }
            catch (caught) {
                warning(`Couldn't comment the plan: ${caught instanceof Error ? caught.message : caught}`);
            }
        }
    }
    if (manifest.failed.length > 0) {
        error(`Planning failed for ${manifest.failed.map((stack) => stack.id).join(', ')}`);
    }
}
/** The pull request's head commit: the code the author pushed */
async function headOf(api, number, event) {
    const pull = event.payload.pull_request;
    if (pull?.number === number && pull.head?.sha)
        return pull.head.sha;
    const fetched = await api.request('GET', api.repo(`/pulls/${number}`));
    return fetched.head.sha;
}
function createStacksInput() {
    const value = input('create-stacks') || 'plan';
    if (value !== 'plan' && value !== 'apply') {
        throw new Error(`create-stacks must be plan or apply, not "${value}"`);
    }
    return value;
}
main().catch((caught) => {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
});
