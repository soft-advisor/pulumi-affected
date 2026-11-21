import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyPlans } from "../plan/apply.js";
import { eventContext } from "./context.js";
import { MANIFEST_FILE } from "../plan/manifest.js";
import { describeRead } from "../plan/outputs.js";
import { renderApply } from "../plan/report.js";
import { commandRunner, DEFAULT_COMMAND } from "../pulumi/runner.js";
import { git, repoRootOf } from "../snapshot.js";
import { marker, syncComments } from "./comments.js";
import { appendSummary, booleanInput, error, GitHubApi, input, notice, printUntrusted, readEvent, setOutput, warning, } from "./github.js";
import { splitPatterns } from "../patterns.js";
import { positiveInteger, pullRequestNumber } from "./inputs.js";
/*
 * The `apply` action's Node steps. `locate` works out where the plans come from: a directory
 * that already holds them, a given run's artifact, or the newest artifact for the checked-out
 * tree, which the composite action then downloads. `apply` applies them.
 */
const APPLY_COMMENT_FILE = 'apply-comment.md';
/** A run of this repository's own branches; a fork's run could upload any plans */
function isOwnRun(run) {
    return (typeof run?.repository_id === 'number' &&
        typeof run.head_repository_id === 'number' &&
        run.repository_id === run.head_repository_id);
}
/**
 * The pull requests the checked-out commit belongs to: the triggering one, the pull-request
 * input, or those a pushed commit was merged from
 */
async function pullRequestsOf(api, sha) {
    const number = pullRequestNumber(readEvent());
    if (number !== undefined) {
        return [await api.request('GET', api.repo(`/pulls/${number}`))];
    }
    return api.request('GET', api.repo(`/commits/${sha}/pulls`));
}
/**
 * Commits whose plan runs may supply the plans: the head of the pull request this code came
 * from, or this commit itself. Another branch's run can't, even with the same tree: its plans
 * weren't the ones reviewed.
 */
async function trustedHeads(api, sha) {
    const explicit = input('plan-sha');
    if (explicit)
        return new Set([explicit]);
    const heads = new Set([sha]);
    for (const pull of await pullRequestsOf(api, sha))
        heads.add(pull.head.sha);
    return heads;
}
async function locate() {
    const repoRoot = repoRootOf(input('working-directory') || process.cwd());
    const tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
    const sha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const name = `pulumi-plans-${tree}`;
    const directory = input('directory');
    if (directory && existsSync(join(resolve(directory), MANIFEST_FILE))) {
        setOutput('download', 'false');
        setOutput('directory', resolve(directory));
        return;
    }
    // Downloads go outside the checkout, so they can never land on its files
    const target = join(process.env.RUNNER_TEMP ?? resolve('..'), name);
    const token = input('github-token');
    if (!token)
        throw new Error('No plans in directory and no github-token to find their artifact');
    const api = new GitHubApi(token);
    const heads = await trustedHeads(api, sha);
    let runId = input('run-id');
    if (!runId) {
        const { artifacts } = await api.request('GET', api.repo(`/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`));
        const usable = artifacts
            .filter((artifact) => artifact.name === name &&
            !artifact.expired &&
            isOwnRun(artifact.workflow_run) &&
            heads.has(artifact.workflow_run?.head_sha ?? ''))
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (usable.length === 0) {
            throw new Error(`No artifact ${name} from a run of ${[...heads].join(' or ')}: plan this exact code first (the checkout's tree is ${tree})`);
        }
        runId = String(usable[0].workflow_run?.id);
    }
    else {
        const run = await api.request('GET', api.repo(`/actions/runs/${encodeURIComponent(runId)}`));
        if (!isOwnRun({ repository_id: run.repository?.id, head_repository_id: run.head_repository?.id })) {
            throw new Error(`Run ${runId} isn't from this repository's own branches`);
        }
        if (!heads.has(run.head_sha)) {
            throw new Error(`Run ${runId} ran on ${run.head_sha}, not on ${[...heads].join(' or ')}; set plan-sha if that's intended`);
        }
    }
    setOutput('download', 'true');
    setOutput('name', name);
    setOutput('run-id', runId);
    setOutput('directory', target);
}
/**
 * How the change is selected, as the plan selected it: its base (the input, else the event's),
 * Pulumi-Affected-Run/Skip lines in its pull request, and the same run/skip/all/bases inputs
 */
async function selection(cwd) {
    const repoRoot = repoRootOf(cwd);
    const explicitBase = input('base');
    const context = explicitBase ? undefined : eventContext(readEvent(), repoRoot);
    for (const message of context?.warnings ?? [])
        warning(message);
    const base = explicitBase || context?.base;
    if (!base && !booleanInput('all') && !context?.all) {
        throw new Error("There's no revision to compare with, so which stacks this change selects can't be checked; set the base input");
    }
    const messages = [...(context?.messages ?? [])];
    const token = input('github-token');
    if (token && messages.length === 0) {
        const sha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
        for (const pull of await pullRequestsOf(new GitHubApi(token), sha)) {
            messages.push(pull.body ?? '');
        }
    }
    return {
        base: base || 'HEAD',
        bases: input('bases') ? JSON.parse(input('bases')) : undefined,
        run: splitPatterns(input('run')),
        skip: splitPatterns(input('skip')),
        all: booleanInput('all') || context?.all,
        messages,
    };
}
async function apply() {
    const cwd = input('working-directory') || process.cwd();
    const directory = resolve(input('plans'));
    const result = await applyPlans({
        select: await selection(cwd),
        failFast: booleanInput('fail-fast'),
        cwd,
        directory,
        runner: commandRunner(input('command') || DEFAULT_COMMAND, repoRootOf(cwd)),
        concurrency: positiveInteger('concurrency', 4),
        allow: input('stacks') ? splitPatterns(input('stacks')) : undefined,
        onFinish: (stack) => {
            if (stack.error)
                printUntrusted(`${stack.id}: ${stack.outcome}\n${stack.error}`);
            else
                console.log(`${stack.id}: ${stack.outcome}`);
        },
    });
    for (const message of result.warnings)
        warning(message);
    const report = renderApply(result, (index) => marker('apply', index));
    writeFileSync(join(directory, APPLY_COMMENT_FILE), report.bodies.join('\n\n'));
    appendSummary(report.summary);
    setOutput('directory', directory);
    setOutput('result', JSON.stringify({
        stacks: result.stacks,
        needsPlan: result.needsPlan,
        followUps: result.followUps,
        warnings: result.warnings,
    }));
    setOutput('needs-plan', JSON.stringify(result.needsPlan));
    setOutput('failed', result.ok ? 'false' : 'true');
    for (const read of result.followUps) {
        warning(`Plan ${read.id} again: it ${describeRead(read)}`);
    }
    if (booleanInput('comment')) {
        const token = input('github-token');
        const number = pullRequestNumber(readEvent()) ?? (token ? await mergedPullRequest(token, cwd) : undefined);
        if (number === undefined)
            notice('No pull request found for this commit, so the apply isn’t commented');
        else if (!token)
            warning('No github-token, so the apply isn’t commented');
        else {
            try {
                await syncComments(new GitHubApi(token), number, 'apply', report.bodies);
            }
            catch (caught) {
                warning(`Couldn't comment the apply: ${caught instanceof Error ? caught.message : caught}`);
            }
        }
    }
    if (!result.ok)
        error('Not every plan was applied');
}
/** The pull request a pushed commit came from */
async function mergedPullRequest(token, cwd) {
    const api = new GitHubApi(token);
    const sha = git(repoRootOf(cwd), ['rev-parse', 'HEAD']).trim();
    const pulls = await api.request('GET', api.repo(`/commits/${sha}/pulls`));
    return pulls.find((pull) => pull.merged_at)?.number ?? pulls[0]?.number;
}
const step = process.argv[2] === 'locate' ? locate : apply;
step().catch((caught) => {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
});
