import { createHash } from 'node:crypto';
import type { Author, GitHubApi } from './github.ts';

export interface Comment {
  id: number;
  node_id?: string;
  body?: string;
  user: Author | null;
}

/*
 * Pull request comments the action owns, found again by a hidden marker on their first line:
 * `<!-- pulumi-affected:<kind>:<index> -->`. A report split over several comments has one
 * index per comment; when a later report needs fewer, the extra ones are deleted.
 */

export function marker(kind: string, index: number) {
  return `<!-- pulumi-affected:${kind}:${index} -->`;
}

/**
 * Makes the pull request's `kind` comments match `bodies`, editing existing ones in place.
 * With `onlyIfPresent`, nothing is posted when there's no earlier comment to update.
 */
export async function syncComments(
  api: GitHubApi,
  number: number,
  kind: string,
  bodies: string[],
  onlyIfPresent = false,
) {
  const prefix = `<!-- pulumi-affected:${kind}:`;
  const comments = await api.list<Comment>(api.repo(`/issues/${number}/comments`));
  // Anyone can post a comment starting with the marker; only the action's own are its reports
  const isOwn = await api.ownComments();
  const existing = new Map<number, Comment>();
  const duplicates: Comment[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!isOwn(comment.user) || !body.startsWith(prefix)) continue;
    const index = Number(body.slice(prefix.length, body.indexOf(' -->')));
    if (!Number.isInteger(index)) continue;
    // Two overlapping runs can both post the same part; the later copies go
    if (existing.has(index)) duplicates.push(comment);
    else existing.set(index, comment);
  }
  for (const duplicate of duplicates) {
    await api.request('DELETE', api.repo(`/issues/comments/${duplicate.id}`));
  }
  if (onlyIfPresent && existing.size === 0) return;

  for (const [index, body] of bodies.entries()) {
    const comment = existing.get(index);
    if (comment) {
      if (comment.body !== body) {
        await api.request('PATCH', api.repo(`/issues/comments/${comment.id}`), { body });
      }
    } else {
      await api.request('POST', api.repo(`/issues/${number}/comments`), { body });
    }
  }
  for (const [index, comment] of existing) {
    if (index >= bodies.length) {
      await api.request('DELETE', api.repo(`/issues/comments/${comment.id}`));
    }
  }
}

/** What a report was made from, shown in it: e.g. "Previewed" at the pull request's head */
export interface ReportStatus {
  verb: string;
  sha: string;
  url: string;
}

const DIGEST = /^<!-- pulumi-affected:digest:([0-9a-f]{64}) -->$/m;

/**
 * Posts a report that's read when it changes. When the results differ from the last report, the
 * old comments are hidden as outdated and the new ones posted, so GitHub notifies; when they're
 * the same, the existing comments are only updated to say so, which notifies no one.
 */
export async function postReport(
  api: GitHubApi,
  number: number,
  kind: string,
  bodies: string[],
  status: ReportStatus,
) {
  // The results only: the footer names the commit, which differs on every push
  const results = bodies.join('\n').replace(/^<sub>.*<\/sub>$/gm, '');
  const digest = createHash('sha256').update(results).digest('hex');
  const existing = await ownReports(api, number, kind);
  const previous = existing.get(0)?.body?.match(DIGEST)?.[1];
  const link = `[${status.sha.slice(0, 7)}](${status.url})`;
  const same = previous === digest;
  const line = same
    ? `${status.verb} again against ${link}, no change.`
    : `${status.verb} against ${link}.`;
  const final = withStatus(bodies, line, digest);
  if (same) {
    await syncComments(api, number, kind, final);
    return;
  }
  for (const comment of existing.values()) await retire(api, kind, comment);
  for (const body of final) {
    await api.request('POST', api.repo(`/issues/${number}/comments`), { body });
  }
}

/** The report with its status line under the heading, and the digest of its results */
function withStatus(bodies: string[], line: string, digest: string) {
  return bodies.map((body, index) => {
    if (index > 0) return body;
    const lines = body.split('\n');
    // The marker, then the heading
    return [
      lines[0],
      `<!-- pulumi-affected:digest:${digest} -->`,
      lines[1],
      '',
      line,
      ...lines.slice(2),
    ].join('\n');
  });
}

async function ownReports(api: GitHubApi, number: number, kind: string) {
  const prefix = `<!-- pulumi-affected:${kind}:`;
  const comments = await api.list<Comment>(api.repo(`/issues/${number}/comments`));
  const isOwn = await api.ownComments();
  const reports = new Map<number, Comment>();
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!isOwn(comment.user) || !body.startsWith(prefix)) continue;
    const index = Number(body.slice(prefix.length, body.indexOf(' -->')));
    if (Number.isInteger(index) && !reports.has(index)) reports.set(index, comment);
  }
  return reports;
}

/**
 * Marks an old report as outdated: its marker changes, so it's never updated again, and it's
 * hidden as outdated. Hiding is best effort; the marker change is what matters.
 */
async function retire(api: GitHubApi, kind: string, comment: Comment) {
  const body = (comment.body ?? '').replace(
    `<!-- pulumi-affected:${kind}:`,
    `<!-- pulumi-affected:${kind}-outdated:`,
  );
  await api.request('PATCH', api.repo(`/issues/comments/${comment.id}`), { body });
  if (!comment.node_id) return;
  try {
    await api.graphql(
      'mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
      { id: comment.node_id },
    );
  } catch {
    // Still marked; just not hidden
  }
}
