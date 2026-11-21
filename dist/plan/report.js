import { formatCounts } from "../classify.js";
import { code, reasonText, safeText } from "../render.js";
import { fence, splitComments } from "../action/split.js";
import { describeRead } from "./outputs.js";
/*
 * Markdown for plans and applies: one report for the job summary, and the same split into pull
 * request comments that fit GitHub's limit. Names and Pulumi's messages come from the
 * repository, so they're escaped or fenced.
 */
/** Changes listed per stack before the rest are only counted */
const MAX_CHANGES = 50;
export function renderPlan(manifest, marker) {
    const heading = `### pulumi-affected plan: ${planHeadline(manifest)}`;
    const rows = [
        ...manifest.stacks.map((stack) => `| ${code(stack.id)} | ${planSummary(stack)} | ${stack.reasons.map(reasonText).join('<br>')} |`),
        ...manifest.failed.map((stack) => `| ${code(stack.id)} | **failed** | ${stack.reasons.map(reasonText).join('<br>')} |`),
    ];
    const blocked = manifest.failed.filter((stack) => stack.blockedBy);
    const intro = [
        ...blocked.map((stack) => `> [!CAUTION]\n> ${code(stack.id)} can't be planned in this change: it ${(stack.blockedBy ?? []).map(readText).join('; ')}. Its plan would be made with the old values. Change ${[...new Set((stack.blockedBy ?? []).map((read) => code(read.dependency)))].join(', ')} first and ${code(stack.id)} in a later pull request, or leave it out of this one with ${code(`Pulumi-Affected-Skip: ${stack.id}`)} and plan it after this is applied.`),
        manifest.followUps.length > 0
            ? `> [!WARNING]\n> **Plan again after this is applied:**\n${manifest.followUps.map((read) => `> - ${code(read.id)} ${readText(read)}${manifest.skipped.some((skip) => skip.id === read.id) ? ', and has changes this pull request skips' : ''}`).join('\n')}`
            : '',
        rows.length > 0
            ? ['| Stack | Plan | Why |', '| --- | --- | --- |', ...rows].join('\n')
            : 'Nothing to apply.',
        lists(manifest),
    ]
        .filter(Boolean)
        .join('\n\n');
    const sections = [
        ...manifest.failed
            .filter((stack) => !stack.blockedBy)
            .map((stack) => `<details><summary>${code(stack.id)} failed</summary>\n\n${fence(stack.error)}\n\n</details>`),
        ...manifest.stacks.filter((stack) => stack.changes.length > 0).map(changesSection),
        `<sub>Planned ${manifest.head.slice(0, 7)} (tree ${manifest.tree.slice(0, 7)}) against ${manifest.base.slice(0, 7)} with Pulumi ${safeText(manifest.pulumiVersion)}</sub>`,
    ];
    const bodies = splitComments(heading, intro, sections, marker);
    return { summary: [heading, intro, ...sections].join('\n\n'), bodies };
}
export function renderApply(result, marker) {
    const counts = new Map();
    for (const stack of result.stacks)
        counts.set(stack.outcome, (counts.get(stack.outcome) ?? 0) + 1);
    const headline = result.stacks.length === 0
        ? 'nothing to apply'
        : [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(', ');
    const heading = `### pulumi-affected apply: ${headline}`;
    const rows = result.stacks.map((stack) => `| ${code(stack.id)} | ${stack.outcome === 'applied' || stack.outcome === 'already-applied' ? stack.outcome : `**${stack.outcome}**`} |`);
    const intro = [
        rows.length > 0 ? ['| Stack | Result |', '| --- | --- |', ...rows].join('\n') : '',
        result.followUps.length > 0
            ? `> [!WARNING]\n> **Plan again now:**\n${result.followUps.map((read) => `> - ${code(read.id)} ${readText(read)}`).join('\n')}`
            : '',
        ...result.warnings.map((warning) => `> ${safeText(warning)}`),
        relaxedNote(result),
    ]
        .filter(Boolean)
        .join('\n\n');
    const sections = [
        ...result.stacks
            .filter((stack) => stack.error)
            .map((stack) => `<details><summary>${code(stack.id)} ${safeText(stack.outcome)}</summary>\n\n${fence(stack.error ?? '')}\n\n</details>`),
        `<sub>Applied plans for ${result.manifest.head.slice(0, 7)} (tree ${result.manifest.tree.slice(0, 7)})</sub>`,
    ];
    const bodies = splitComments(heading, intro || 'Nothing to apply.', sections, marker);
    return { summary: [heading, intro, ...sections].join('\n\n'), bodies };
}
/** Plan properties left open by ignore rules, so reviewers can see what wasn't held to the plan */
function relaxedNote(result) {
    const relaxed = result.stacks.flatMap((stack) => stack.relaxed ?? []);
    if (relaxed.length === 0)
        return '';
    return `<details><summary>${relaxed.length} properties left open by <code>classify.ignore</code></summary>\n\n${relaxed.map((entry) => `- ${code(entry)}`).join('\n')}\n\n</details>`;
}
/** A stale read as escaped Markdown: names from the repository become code */
function readText(read) {
    return reasonText(describeRead(read));
}
function planSummary(stack) {
    const parts = [safeText(countsOf(stack))];
    if (stack.outputs.length > 0)
        parts.push(`outputs: ${stack.outputs.map(code).join(', ')}`);
    if (stack.created)
        parts.push('new stack');
    return parts.join('; ');
}
function planHeadline(manifest) {
    const parts = [`${manifest.stacks.length} to apply`];
    if (manifest.unchanged.length > 0)
        parts.push(`${manifest.unchanged.length} unchanged`);
    if (manifest.failed.length > 0)
        parts.push(`${manifest.failed.length} failed`);
    return parts.join(', ');
}
function countsOf(stack) {
    return formatCounts({
        changed: true,
        counts: stack.counts,
        changes: [],
        outputs: [],
        ignored: [],
    });
}
function lists(manifest) {
    const lines = [];
    if (manifest.unchanged.length > 0) {
        lines.push(`Previewed without changes: ${manifest.unchanged.map((stack) => code(stack.id)).join(', ')}`);
    }
    for (const stack of manifest.skipped) {
        lines.push(`Skipped by ${safeText(stack.source)}: ${code(stack.id)}`);
    }
    if (manifest.warnings.length > 0) {
        lines.push(`<details><summary>${manifest.warnings.length} warnings</summary>\n\n${manifest.warnings.map((warning) => `- ${safeText(warning)}`).join('\n')}\n\n</details>`);
    }
    return lines.join('\n\n');
}
function changesSection(stack) {
    const shown = stack.changes.slice(0, MAX_CHANGES);
    const lines = shown.map((change) => `| ${safeText(change.op)} | ${code(change.type)} | ${code(change.name)} | ${change.properties.map(code).join(', ')} |`);
    const more = stack.changes.length - shown.length;
    return [
        `<details><summary>${code(stack.id)}: ${safeText(countsOf(stack))}</summary>`,
        '',
        '| Op | Type | Name | Properties |',
        '| --- | --- | --- | --- |',
        ...lines,
        ...(more > 0 ? ['', `and ${more} more`] : []),
        '',
        '</details>',
    ].join('\n');
}
