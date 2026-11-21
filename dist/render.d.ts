import type { SelectResult } from './select.ts';
/** A Markdown summary of a selection, for job summaries and pull request comments */
export declare function renderMarkdown(result: SelectResult): string;
/**
 * Text from outside the tool, for a table cell or code span: HTML-escaped, with the characters
 * Markdown acts on as entities too, so repository content can't add links, images, mentions or
 * formatting
 */
export declare function safeText(text: string): string;
/** A name in code style; <code> rather than backticks, so a backtick in it can't break out */
export declare function code(text: string): string;
/**
 * A reason, which is the tool's own text with names from the repository in backticks: the names
 * become code, and everything is escaped
 */
export declare function reasonText(text: string): string;
