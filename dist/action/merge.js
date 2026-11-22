import { git } from "../snapshot.js";
/*
 * A pull request run checks out GitHub's merge of the pull request into its base. GitHub
 * computes that merge in the background, so right after the base changes (a retarget, or the
 * base branch moving) the run can get one made with the old base. This waits for GitHub's new
 * merge and checks it out, so the preview is of the code that would be merged. GitHub gives no
 * duration for this; it reports `mergeable: null` while it's still working.
 */
const POLL_MS = 5_000;
const WAIT_MS = 120_000;
export async function ensureCurrentMerge(repoRoot, event, api, token, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    if (event.name !== 'pull_request')
        return { kind: 'current' };
    const pull = event.payload.pull_request;
    const base = pull?.base?.sha;
    if (!pull?.number || !base)
        return { kind: 'current' };
    // A shallow checkout can't tell; the preview needs history anyway (fetch-depth: 0)
    try {
        git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^1']);
    }
    catch {
        return { kind: 'current' };
    }
    fetchCommit(repoRoot, base, token);
    if (mergesInto(repoRoot, 'HEAD', base))
        return { kind: 'current' };
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const current = await api.request('GET', api.repo(`/pulls/${pull.number}`));
        const sha = current.merge_commit_sha;
        if (current.mergeable !== null && sha && fetchCommit(repoRoot, sha, token)) {
            if (mergesInto(repoRoot, sha, current.base.sha)) {
                git(repoRoot, ['checkout', '--quiet', '--detach', sha]);
                return { kind: 'refreshed', sha };
            }
        }
        if (Date.now() + POLL_MS > deadline)
            return { kind: 'stale', base };
        await sleep(POLL_MS);
    }
}
/** Whether a merge commit's first parent is (or includes) the base commit */
function mergesInto(repoRoot, commit, base) {
    try {
        const parent = git(repoRoot, ['rev-parse', `${commit}^1`]).trim();
        git(repoRoot, ['merge-base', '--is-ancestor', base, parent]);
        return true;
    }
    catch {
        return false;
    }
}
/** Fetches a commit with the job's token, as the checkout may not have kept credentials */
export function fetchCommit(repoRoot, sha, token) {
    try {
        git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
        return true;
    }
    catch {
        // Not here yet
    }
    const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    try {
        git(repoRoot, [
            '-c',
            `http.${server}/.extraheader=AUTHORIZATION: basic ${basic}`,
            'fetch',
            '--quiet',
            '--no-tags',
            `${server}/${repository}`,
            sha,
        ]);
        return true;
    }
    catch {
        return false;
    }
}
