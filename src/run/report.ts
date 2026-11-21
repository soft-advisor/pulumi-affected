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
  failed: 'failed',
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
    const result = run.status === 'failed' ? '<b>failed</b>' : cell(resultText(run));
    lines.push(`| ${label} | ${result} | ${run.reasons.map(reasonText).join('<br>')} |`);
  }
  return lines.join('\n');
}

/**
 * A stack's details: its resource changes, or its error. Too long for `maxLength`, the error or
 * the list of changes is cut short before it's fenced or tabled, so the Markdown stays whole.
 */
export function renderStackDetails(run: StackRun, maxLength = COMMENT_LIMIT, runUrl?: string) {
  const title = `<details><summary>${code(run.stack.id)}: ${cell(resultText(run))}</summary>\n\n`;
  const end = '\n\n</details>';
  const cutNote = `\n\n…cut short; the full output is in the ${runUrl ? `[run](${runUrl})` : 'run log'}.`;
  const notes = run.notes?.length
    ? `${run.notes.map((note) => `> [!WARNING]\n> ${reasonText(note)}`).join('\n\n')}\n\n`
    : '';
  // Room for the body, keeping space for the fence or table header and the note
  const room = maxLength - title.length - end.length - notes.length - cutNote.length - 200;

  let body: string;
  let cut = false;
  if (run.error) {
    cut = run.error.length > room;
    body = fence(cut ? `${run.error.slice(0, Math.max(room, 0))}\n…` : run.error);
  } else {
    const changes = run.classification?.changes ?? [];
    const rows = changes.map(
      (change) =>
        `| ${OP_SYMBOLS[change.op] ?? cell(change.op)} | ${code(change.name)} | ${code(change.type)} | ${change.properties.map(code).join(', ')} |`,
    );
    // Outputs the preview saw change, and those a deploy changed
    const outputs = [
      ...new Set([...(run.classification?.outputs ?? []), ...(run.changedOutputs ?? [])]),
    ];
    if (outputs.length > 0) rows.push(`| ~ | outputs | | ${outputs.map(code).join(', ')} |`);
    const kept: string[] = [];
    let length = 0;
    for (const row of rows) {
      if (length + row.length + 1 > room) {
        cut = true;
        break;
      }
      kept.push(row);
      length += row.length + 1;
    }
    body = ['| | Resource | Type | Properties |', '| --- | --- | --- | --- |', ...kept].join('\n');
    const ignored = run.classification?.ignored.length ?? 0;
    if (ignored > 0)
      body += `\n\n${ignored} ignored by <code>classify.ignore</code> in the config.`;
  }
  return title + notes + body + (cut ? cutNote : '') + end;
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
  const [first, ...more] = splitTable(intro, limit - heading.length - 400);
  let current = `${heading}\n\n${first}`;
  for (const section of [...more, ...sections]) {
    if (current.length + section.length + 2 > limit - 200) {
      bodies.push(current);
      current = `${heading} (continued)`;
    }
    current += `\n\n${section}`;
  }
  bodies.push(current);
  return bodies.map((body, index) => `${marker(index)}\n${body}`);
}

/** A table too long for one comment, as several, each with the header rows */
function splitTable(table: string, limit: number) {
  if (table.length <= limit) return [table];
  const [header, divider, ...rows] = table.split('\n');
  const parts: string[] = [];
  let current = `${header}\n${divider}`;
  for (const row of rows) {
    if (current.length + row.length + 1 > limit) {
      parts.push(current);
      current = `${header}\n${divider}`;
    }
    current += `\n${row}`;
  }
  parts.push(current);
  return parts;
}

/**
 * Text for a table cell or code span: HTML-escaped, with the characters Markdown acts on as
 * entities too, so repository content can't add links, images, mentions or formatting
 */
function cell(text: string) {
  return escapeHtml(text)
    .replace(/[|[\]()!@#*_~`:\\<>]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/\n/g, ' ');
}

/**
 * A reason, which is the tool's own text with names from the repository in backticks: the names
 * become code, and everything is escaped
 */
export function reasonText(text: string) {
  return text
    .split('`')
    .map((part, index) => (index % 2 === 1 ? code(part) : cell(part)))
    .join('');
}

/** A name in code style; <code> rather than backticks, so a backtick in it can't break out */
export function code(text: string) {
  return `<code>${cell(text)}</code>`;
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The Markdown-safe form of any text from outside the tool */
export { cell as safeText };

function fence(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
