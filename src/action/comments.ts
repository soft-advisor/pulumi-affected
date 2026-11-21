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
  const existing = new Map<number, Comment>();
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!body.startsWith(prefix)) continue;
    const index = Number(body.slice(prefix.length, body.indexOf(' -->')));
    if (Number.isInteger(index) && !existing.has(index)) existing.set(index, comment);
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
