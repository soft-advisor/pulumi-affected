import { code, reasonText, safeText } from './run/report.ts';
import type { SelectResult } from './select.ts';

/** A Markdown summary of a selection, for job summaries and pull request comments */
export function renderMarkdown(result: SelectResult) {
  const total = result.stacks.length + result.unaffected.length;
  const lines = [`### pulumi-affected: ${result.stacks.length} of ${total} stacks selected`, ''];
  if (result.stacks.length > 0) {
    lines.push('| Wave | Stack | Why |', '| --- | --- | --- |');
    for (const stack of result.stacks) {
      const why = stack.reasons.map(reasonText).join('<br>');
      lines.push(`| ${stack.wave + 1} | ${code(stack.id)} | ${why} |`);
    }
    lines.push('');
  }
  if (result.skipped.length > 0) {
    lines.push('**Skipped** although affected:', '');
    for (const stack of result.skipped) {
      lines.push(
        `- ${code(stack.id)}, skipped by ${safeText(stack.source)}: ${stack.reasons.map(reasonText).join('; ')}`,
      );
    }
    lines.push('');
  }
  if (result.unaffected.length > 0) {
    lines.push(
      `<details><summary>${result.unaffected.length} unaffected</summary>`,
      '',
      result.unaffected.map(code).join(', '),
      '',
      '</details>',
      '',
    );
  }
  if (result.warnings.length > 0) {
    lines.push(
      `<details><summary>${result.warnings.length} warnings</summary>`,
      '',
      ...result.warnings.map((warning) => `- ${safeText(warning)}`),
      '',
      '</details>',
      '',
    );
  }
  lines.push(`<sub>Compared ${result.base.slice(0, 7)} with ${shortLabel(result.head)}</sub>`);
  return lines.join('\n');
}

function shortLabel(label: string) {
  return /^[0-9a-f]{40}$/.test(label) ? label.slice(0, 7) : label;
}
