type TestRegistrar = typeof import('node:test').it;

export function createPartitionedTestRegistrar(
    registrar: TestRegistrar,
    envName: string,
    partCount: number
): TestRegistrar {
    if (!Number.isInteger(partCount) || partCount < 1) {
        throw new Error(`Test partition count must be a positive integer, received '${partCount}'.`);
    }
    const rawPart = String(process.env[envName] || '').trim();
    const selectedPart = rawPart ? Number(rawPart) : null;
    if (
        selectedPart !== null
        && (!Number.isInteger(selectedPart) || selectedPart < 0 || selectedPart >= partCount)
    ) {
        throw new Error(`${envName} must be an integer from 0 through ${partCount - 1}.`);
    }
    const invokeRegistrar = registrar as unknown as (...args: unknown[]) => Promise<void>;
    let nextTestIndex = 0;
    return ((...args: unknown[]): Promise<void> => {
        const testIndex = nextTestIndex;
        nextTestIndex += 1;
        if (selectedPart === null || testIndex % partCount === selectedPart) {
            return invokeRegistrar(...args);
        }
        return Promise.resolve();
    }) as unknown as TestRegistrar;
}
