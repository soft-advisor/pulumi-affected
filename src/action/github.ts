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

export interface Author {
  login: string;
  type?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 2_000;
const MAX_RETRY_DELAY = 30_000;

export class GitHubApi {
  private readonly token: string;
  private readonly baseUrl: string;
  readonly repository: string;

  constructor(token: string, repository = process.env.GITHUB_REPOSITORY ?? '') {
    this.token = token;
    this.baseUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    this.repository = repository;
  }

  /**
   * Calls the API, retrying server errors and rate limits a few times with backoff, since one
   * transient failure shouldn't fail a deploy
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
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
      const text = await response.text();
      if (response.ok) {
        // DELETE and some other calls answer 204 with no body
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const limited =
        response.status === 429 || (response.status === 403 && /rate limit/i.test(text));
      const transient = response.status >= 500 || limited;
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw new ApiError(
          response.status,
          `GitHub API ${method} ${path} failed with ${response.status}: ${text}`,
        );
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : attempt * RETRY_DELAY;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, MAX_RETRY_DELAY)));
    }
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

  private ownership: Promise<(author: Author | null) => boolean> | undefined;

  /**
   * How to tell the action's own comments: by the login behind a personal token, or, for
   * the workflow's token and GitHub App tokens (which can't read /user and post as
   * <name>[bot]), by being a bot. Only installed apps can be bots, and only people with write
   * access can install apps.
   */
  ownComments() {
    this.ownership ??= this.request<{ login: string }>('GET', '/user').then(
      (user) => (author: Author | null) => author?.login === user.login,
      (error: unknown) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return (author: Author | null) => author?.type === 'Bot';
        }
        throw error;
      },
    );
    return this.ownership;
  }

  repo(path: string) {
    return `/repos/${this.repository}${path}`;
  }
}
