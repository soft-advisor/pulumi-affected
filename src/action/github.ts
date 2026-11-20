import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

/*
 * The parts of the GitHub Actions runtime the action uses, without @actions/* dependencies:
 * inputs and the event come from environment variables and files, outputs and the job summary go
 * to files, and the REST API is called with fetch.
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

export class GitHubApi {
  private readonly token: string;
  private readonly baseUrl: string;
  readonly repository: string;

  constructor(token: string, repository = process.env.GITHUB_REPOSITORY ?? '') {
    this.token = token;
    this.baseUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    this.repository = repository;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${text}`);
    }
    return (await response.json()) as T;
  }

  /** Every page of a list endpoint */
  async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>('GET', `${path}${separator}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  repo(path: string) {
    return `/repos/${this.repository}${path}`;
  }
}
