import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stack } from '../src/projects.ts';
import type { CommandResult, PulumiRunner } from '../src/run/pulumi.ts';
import { splitComments } from '../src/run/report.ts';
import { runStacks } from '../src/run/runner.ts';

const stack = (name: string): Stack => ({
  id: `p/${name}`,
  project: 'p',
  dir: 'p',
  stack: name,
  configFile: `p/Pulumi.${name}.yaml`,
});

const PLAN = JSON.stringify({
  steps: [{ op: 'update', urn: 'urn:pulumi:s::p::t::r', newState: { type: 't' } }],
});

/** A Pulumi that fails `up` for some stacks and gives others new outputs */
function fakeRunner(behaviour: Record<string, 'fail' | 'new-outputs' | 'same'>): PulumiRunner {
  const deployed = new Set<string>();
  return {
    async run(target, args): Promise<CommandResult> {
      const kind = behaviour[target.stack] ?? 'same';
      if (args[0] === 'stack' && args[1] === 'output') {
        const value = kind === 'new-outputs' && deployed.has(target.stack) ? 'new' : 'old';
        return { code: 0, stdout: JSON.stringify({ value }), stderr: '' };
      }
      if (args[0] === 'up') {
        if (kind === 'fail') return { code: 255, stdout: '', stderr: 'error: boom' };
        deployed.add(target.stack);
        return { code: 0, stdout: PLAN, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async runPulumi() {
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('a stack never deploys when a dependency failed, even if another changed its outputs', async () => {
  const [a, b, c] = [stack('a'), stack('b'), stack('c')];
  const runs = await runStacks({
    mode: 'up',
    stacks: [a, b].map((s) => ({ stack: s, reasons: ['changed'] })),
    allStacks: [a, b, c],
    graph: new Map([['p/c', new Set(['p/a', 'p/b'])]]),
    runner: fakeRunner({ a: 'fail', b: 'new-outputs' }),
    repoRoot: '/nonexistent',
    ignore: [],
    concurrency: 2,
    failFast: false,
  });
  const byId = Object.fromEntries(runs.map((run) => [run.stack.id, run]));
  assert.equal(byId['p/a'].status, 'failed');
  assert.equal(byId['p/b'].status, 'changes');
  assert.equal(byId['p/c'].status, 'skipped');
  assert.match(
    byId['p/c'].error ?? '',
    /p\/a failed.*its inputs changed in this run, so run it again/,
  );
});

test('a dependent whose dependency changed outputs deploys after it', async () => {
  const [a, c] = [stack('a'), stack('c')];
  const order: string[] = [];
  const runs = await runStacks({
    mode: 'up',
    stacks: [{ stack: a, reasons: ['changed'] }],
    allStacks: [a, c],
    graph: new Map([['p/c', new Set(['p/a'])]]),
    runner: fakeRunner({ a: 'new-outputs' }),
    repoRoot: '/nonexistent',
    ignore: [],
    concurrency: 2,
    failFast: false,
    onFinish: (run) => order.push(run.stack.id),
  });
  assert.deepEqual(order, ['p/a', 'p/c']);
  assert.deepEqual(runs[1].reasons, ['p/a outputs changed: value']);
});

test('an overview table too long for one comment continues in the next', () => {
  const header = '| Stack | Result | Why it ran |\n| --- | --- | --- |';
  const rows = Array.from(
    { length: 2_000 },
    (_, index) => `| \`s${index}\` | +1 | ${'x'.repeat(40)} |`,
  );
  const bodies = splitComments(
    '### Preview',
    `${header}\n${rows.join('\n')}`,
    [],
    (index) => `<!-- m:${index} -->`,
    20_000,
  );
  assert.ok(bodies.length > 1);
  for (const body of bodies) {
    assert.ok(body.length <= 20_000, `${body.length}`);
    assert.ok(body.includes('| Stack | Result | Why it ran |'));
  }
  assert.equal(bodies.join('').match(/\| `s\d+` /g)?.length, 2_000);
});
