import assert from 'node:assert/strict';

/**
 * Stricter assertion for GateChain output lines in CLI tests.
 *
 * Verifies that a line matching the edgeId and status exists
 * and optionally validates the reason and remediation command.
 */
export function assertGateChainDecision(
    output: string | string[],
    expected: {
        edgeId: string;
        status: 'block' | 'pass';
        reason?: string | RegExp;
        remediation?: string | RegExp;
    }
): void {
    const outputLines = typeof output === 'string' ? output.split('\n') : output;
    const pattern = new RegExp(`GateChain ${expected.edgeId} ${expected.status}:`);
    const line = outputLines.find((l) => pattern.test(l));

    if (!line) {
        const availableEdges = outputLines
            .filter((l) => l.includes('GateChain '))
            .map((l) => l.split(': ')[0])
            .join(', ');
        assert.fail(
            `Expected GateChain output for edge "${expected.edgeId}" with status "${expected.status}" not found.\n` +
            `Available GateChain lines: ${availableEdges || 'none'}\n` +
            `Total output lines: ${outputLines.length}`
        );
    }

    if (expected.reason) {
        if (typeof expected.reason === 'string') {
            assert.ok(
                line.includes(expected.reason),
                `GateChain edge "${expected.edgeId}" reason mismatch.\n` +
                `Expected to include: "${expected.reason}"\n` +
                `Actual line: "${line}"`
            );
        } else {
            assert.match(
                line,
                expected.reason,
                `GateChain edge "${expected.edgeId}" reason regex mismatch.\n` +
                `Expected pattern: ${expected.reason}\n` +
                `Actual line: "${line}"`
            );
        }
    }

    if (expected.remediation) {
        if (typeof expected.remediation === 'string') {
            assert.ok(
                line.includes(expected.remediation),
                `GateChain edge "${expected.edgeId}" remediation mismatch.\n` +
                `Expected to include: "${expected.remediation}"\n` +
                `Actual line: "${line}"`
            );
        } else {
            assert.match(
                line,
                expected.remediation,
                `GateChain edge "${expected.edgeId}" remediation regex mismatch.\n` +
                `Expected pattern: ${expected.remediation}\n` +
                `Actual line: "${line}"`
            );
        }
    }
}
