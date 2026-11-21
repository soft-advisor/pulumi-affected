import { formatCounts } from '../classify.ts';
import type { Mode, StackRun } from './runner.ts';

/*
 * Renders run results as Markdown for job summaries and pull request comments. GitHub rejects
 * comments over 65,536 characters, so a long report is split at stack boundaries into several
 * comments, and a single stack too long for one comment is cut short with a link to the run.
 */

export const COMMENT_LIMIT = 60_000;

const STATUS_TEXT: Record<StackRun['status'], string> = {
  changes: '',
  'no-changes': 'no changes',
  failed: '**failed**',
  skipped: 'skipped',
};

const OP_SYMBOLS: Record<string, string> = { create: '+', update: '~', delete: '-', replace: '±' };

export function summaryLine(mode: Mode, runs: StackRun[]) {
  const count = (status: StackRun['status']) => runs.filter((run) => run.status === status).length;
  const verb = mode === 'preview' ? 'Preview' : 'Deploy';
  const changed = mode === 'preview' ? 'with changes' : 'changed';
  const parts = [`${count('changes')} ${changed}`, `${count('no-changes')} without changes`];
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  if (count('skipped') > 0) parts.push(`${count('skipped')} skipped`);
  return `${verb}: ${runs.length} ${runs.length === 1 ? 'stack' : 'stacks'}, ${parts.join(', ')}`;
}

export function resultText(run: StackRun) {
  if (run.status !== 'changes') return STATUS_TEXT[run.status];
  const counts = run.classification ? formatCounts(run.classification) : '';
  const outputs = run.changedOutputs?.length ? `outputs: ${run.changedOutputs.join(', ')}` : '';
  return [counts === 'no changes' ? '' : counts, outputs].filter(Boolean).join(', ') || 'changes';
}

/** The overview table: one row per stack */
export function renderTable(runs: StackRun[]) {
  const lines = ['| Stack | Result | Why it ran |', '| --- | --- | --- |'];
  for (const run of runs) {
    const label = run.newStack ? `${code(run.stack.id)} (new)` : code(run.stack.id);
    lines.push(`| ${label} | ${cell(resultText(run))} | ${run.reasons.map(cell).join('<br>')} |`);
  }
  return lines.join('\n');
}

/** A stack's details: its resource changes, or its error */
export function renderStackDetails(run: StackRun, maxLength = COMMENT_LIMIT, runUrl?: string) {
  const title = `<details><summary>${code(run.stack.id)}: ${cell(resultText(run).replace(/\*\*/g, ''))}</summary>\n\n`;
  const end = '\n\n</details>';
  let body: string;
  if (run.error) {
    body = fence(run.error);
  } else {
    const changes = run.classification?.changes ?? [];
    const rows = changes.map(
      (change) =>
        `| ${OP_SYMBOLS[change.op] ?? cell(change.op)} | ${code(change.name)} | ${code(change.type)} | ${change.properties.map(code).join(', ')} |`,
    );
    const outputs = run.classification?.outputs ?? [];
    if (outputs.length > 0) rows.push(`| ~ | outputs | | ${outputs.map(code).join(', ')} |`);
    body = ['| | Resource | Type | Properties |', '| --- | --- | --- | --- |', ...rows].join('\n');
    const ignored = run.classification?.ignored.length ?? 0;
    if (ignored > 0) body += `\n\n${ignored} ignored by \`classify.ignore\` in the config.`;
  }
  if (run.notes?.length)
    body = `${run.notes.map((note) => `> [!WARNING]\n> ${note}`).join('\n\n')}\n\n${body}`;
  const full = title + body + end;
  if (full.length <= maxLength) return full;
  const note = `\n\n…cut short; the full output is in the ${runUrl ? `[run](${runUrl})` : 'run log'}.`;
  return title + body.slice(0, maxLength - title.length - end.length - note.length) + note + end;
}

/**
 * Splits a report into comment bodies under the limit, at stack boundaries. Each body starts
 * with `marker(index)` so later runs can find and update it.
 */
export function splitComments(
  heading: string,
  intro: string,
  sections: string[],
  marker: (index: number) => string,
  limit = COMMENT_LIMIT,
) {
  const bodies: string[] = [];
  let current = `${heading}\n\n${intro}`;
  for (const section of sections) {
    if (current.length + section.length + 2 > limit - 200) {
      bodies.push(current);
      current = `${heading} (continued)`;
    }
    current += `\n\n${section}`;
  }
  bodies.push(current);
  return bodies.map((body, index) => `${marker(index)}\n${body}`);
}

/** Text for a table cell: HTML-escaped, so repository content can't inject markup */
function cell(text: string) {
  return escapeHtml(text).replace(/\|/g, '&#124;').replace(/\n/g, ' ');
}

/** A name in code style; <code> rather than backticks, so a backtick in it can't break out */
export function code(text: string) {
  return `<code>${cell(text)}</code>`;
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fence(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
