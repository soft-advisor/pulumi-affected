import { ensureCommit, git, isSha } from "../snapshot.js";
const ZERO_SHA = /^0+$/;
const EMPTY = { base: undefined, messages: [], all: false, warnings: [] };
export class EventError extends Error {
}
export function eventContext(event, repoRoot) {
    const payload = event.payload;
    if (event.name === 'pull_request' || event.name === 'pull_request_target') {
        const pullRequest = payload.pull_request;
        return {
            ...EMPTY,
            base: mergeBase(repoRoot, pullRequest.base.sha),
            messages: [pullRequest.body ?? ''],
        };
    }
    if (event.name === 'merge_group') {
        // A merge queue's group is compared with the branch it merges into
        const group = payload.merge_group;
        return { ...EMPTY, base: mergeBase(repoRoot, group.base_sha) };
    }
    if (event.name === 'push') {
        const before = String(payload.before ?? '');
        // A new branch has no previous commit to compare with
        if (!before || ZERO_SHA.test(before))
            return { ...EMPTY, all: true };
        if (!ensureCommit(repoRoot, before)) {
            // A force push: the previous commit is gone
            return {
                ...EMPTY,
                warnings: [`The push's previous commit ${before} isn't available (a force push?)`],
            };
        }
        return { ...EMPTY, base: before };
    }
    return { ...EMPTY };
}
function mergeBase(repoRoot, baseSha) {
    if (!isSha(baseSha))
        throw new EventError(`Not a commit SHA: ${baseSha}`);
    try {
        return git(repoRoot, ['merge-base', baseSha, 'HEAD']).trim();
    }
    catch {
        throw new EventError(`Can't find the merge base with ${baseSha}. Check out with fetch-depth: 0 so history is available.`);
    }
}
