export function staleReads(planned, dependencies, outputsRead) {
    const changed = new Map(planned.filter((stack) => stack.outputs.length > 0).map((stack) => [stack.id, stack]));
    const stale = [];
    for (const [id, stackDependencies] of Object.entries(dependencies)) {
        for (const dependency of stackDependencies) {
            const plan = changed.get(dependency);
            if (!plan)
                continue;
            const outputs = plan.outputs;
            const reads = outputsRead[id]?.[dependency] ?? 'all';
            const read = reads === 'all' ? outputs : outputs.filter((output) => reads.includes(output));
            if (read.length === 0)
                continue;
            const maybe = read.every((output) => plan.unknownOutputs?.includes(output));
            stale.push({
                id,
                dependency,
                outputs: read,
                certain: reads !== 'all',
                ...(maybe ? { maybe } : {}),
            });
        }
    }
    return stale.sort((a, b) => a.id.localeCompare(b.id) || a.dependency.localeCompare(b.dependency));
}
/** "`site/dev` outputs `pageLength`, `url`" style text for reports */
export function describeRead(read) {
    const outputs = read.outputs.map((output) => `\`${output}\``).join(', ');
    const change = read.maybe
        ? 'which this change may alter (their new values are only known once applied)'
        : 'which this change alters';
    return read.certain
        ? `reads ${outputs} from \`${read.dependency}\`, ${change}`
        : `may read ${outputs} from \`${read.dependency}\` (which outputs it reads can't be worked out), ${change}`;
}
