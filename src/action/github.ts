import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

/*
 * The parts of the GitHub Actions runtime the action uses, without @actions/* dependencies:
 * inputs and the event come from environment variables and files, outputs and the job summary go
 * to files.
 */

export function input(name: string) {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
  return value.trim();
}

export function booleanInput(name: string) {
  return /^(true|yes|1)$/i.test(input(name));
}

export function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`${name}=${value}`);
    return;
  }
  const delimiter = `pulumi-affected-${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function appendSummary(markdown: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/**
 * Prints text from outside the action (Pulumi's output, names from the repository) so that no
 * line of it can be read as a workflow command such as ::set-env or ::stop-commands.
 */
export function printUntrusted(text: string) {
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  console.log(text);
  console.log(`::${token}::`);
}

export function error(message: string) {
  console.log(`::error::${escapeCommand(message)}`);
}

export function warning(message: string) {
  console.log(`::warning::${escapeCommand(message)}`);
}

export function notice(message: string) {
  console.log(`::notice::${escapeCommand(message)}`);
}

function escapeCommand(message: string) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface GitHubEvent {
  name: string;
  payload: Record<string, unknown>;
}

export function readEvent(): GitHubEvent {
  const path = process.env.GITHUB_EVENT_PATH;
  return {
    name: process.env.GITHUB_EVENT_NAME ?? '',
    payload: path ? JSON.parse(readFileSync(path, 'utf8')) : {},
  };
}
