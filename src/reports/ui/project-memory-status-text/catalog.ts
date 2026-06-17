import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const PROJECT_MEMORY_STATUS_TEXT_IDS = Object.freeze([
    'memory-enabled',
    'memory-mode',
    'memory-run-before-closeout',
    'memory-require-approval',
    'memory-max-compact-summary-chars',
    'memory-read-strategy',
    'memory-impact-retention-days',
    'memory-initialized',
    'memory-validated',
    'memory-dir',
    'memory-read-first',
    'memory-summary-rule',
    'memory-bootstrap-report'
] as const);

export type ProjectMemoryStatusTextId = typeof PROJECT_MEMORY_STATUS_TEXT_IDS[number];

export function buildProjectMemoryStatusTextCatalog(): Readonly<Record<ProjectMemoryStatusTextId, LocalUiLocalizedText>> {
    return Object.freeze({
        'memory-enabled': {
            label: 'Memory maintenance enabled',
            description: 'Whether workflow closeout checks durable project memory.'
        },
        'memory-mode': {
            label: 'Memory maintenance mode',
            description: 'Current workflow mode: off, check, update, or strict.'
        },
        'memory-run-before-closeout': {
            label: 'Runs before final closeout',
            description: 'Whether the project-memory gate runs before completion.'
        },
        'memory-require-approval': {
            label: 'Requires approval for writes',
            description: 'Whether writes to project-memory files require user approval.'
        },
        'memory-max-compact-summary-chars': {
            label: 'Compact summary size limit',
            description: 'Maximum generated compact project-memory summary size, in characters.'
        },
        'memory-read-strategy': {
            label: 'Read strategy',
            description: 'How agents should read project memory at task start.'
        },
        'memory-impact-retention-days': {
            label: 'Impact artifact retention',
            description: 'How many days project-memory impact artifacts are retained.'
        },
        'memory-initialized': {
            label: 'Initialized by agent init',
            description: 'Whether agent-init recorded project-memory initialization.'
        },
        'memory-validated': {
            label: 'Validated by agent init',
            description: 'Whether agent-init recorded successful project-memory validation.'
        },
        'memory-dir': {
            label: 'Memory directory',
            description: 'Directory that contains the user-owned durable memory files.'
        },
        'memory-read-first': {
            label: 'Read first files',
            description: 'Files agents should read before focused memory files.'
        },
        'memory-summary-rule': {
            label: 'Generated summary rule',
            description: 'Generated rule file that summarizes project memory for agent startup.'
        },
        'memory-bootstrap-report': {
            label: 'Bootstrap report',
            description: 'Runtime report from project-memory bootstrap or validation.'
        }
    });
}

export function listProjectMemoryStatusTextCatalogIds(
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildProjectMemoryStatusTextCatalog()
): string[] {
    return Object.keys(catalog).sort();
}
