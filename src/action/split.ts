/*
 * Splitting a report into PR comments: GitHub rejects comments over 65,536 characters, so a long
 * report continues in further comments, split between sections, and a table too long for one
 * comment repeats its header in the next.
 */

export const COMMENT_LIMIT = 60_000;

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

/** Text in a code block, with a fence longer than any backtick run inside it */
export function fence(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
