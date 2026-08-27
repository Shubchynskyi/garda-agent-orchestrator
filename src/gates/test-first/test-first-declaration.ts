import type { TaskQueueEntry } from '../../core/task-queue-read';

export const TEST_FIRST_EXPECTED_RED_MARKER = 'Test-first: expected-red';

const TEST_FIRST_EXPECTED_RED_PATTERN =
    /(?:^|[.;]\s*)test-first\s*:\s*expected-red(?=\s*(?:[.;]|$))/iu;

export function hasTestFirstExpectedRedDeclaration(
    taskEntry: Pick<TaskQueueEntry, 'notes'> | null | undefined
): boolean {
    return TEST_FIRST_EXPECTED_RED_PATTERN.test(String(taskEntry?.notes || ''));
}
