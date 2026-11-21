import type { Comment } from './context.ts';
import type { GitHubApi } from './github.ts';

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
