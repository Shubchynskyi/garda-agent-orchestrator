import type { ReportDataContract } from '../../report-data-contract';
import {
    buildReportUiTabMetadata,
    defineReportUiTabContract
} from './report-ui-tab-contract';

export type InstructionsReportUiTabStatus = 'empty' | 'present';

export const INSTRUCTIONS_REPORT_UI_TAB_CONTRACT = defineReportUiTabContract({
    id: 'instructions',
    label: {
        key: 'instructionsTab',
        fallback: 'Instructions'
    },
    status: (data: ReportDataContract['instructions_tab']): InstructionsReportUiTabStatus => (
        data.entries.length > 0 ? 'present' : 'empty'
    )
});

export function buildInstructionsReportUiTabMetadata(
    data: ReportDataContract['instructions_tab']
) {
    return buildReportUiTabMetadata(INSTRUCTIONS_REPORT_UI_TAB_CONTRACT, data);
}

/**
 * A remaining shared tab is migrated after each step below is covered in both
 * static HTML and the live dashboard without changing its rendered data.
 */
export const REPORT_UI_TAB_CONTRACT_MIGRATION_STEPS = Object.freeze([
    'define-shared-contract',
    'consume-id-and-label-in-static-html',
    'consume-id-and-localized-label-in-dashboard',
    'preserve-status-path-and-action-behavior',
    'add-static-and-dashboard-render-tests'
] as const);

/** Shared tabs still awaiting the pilot treatment established by instructions. */
export const REPORT_UI_TAB_CONTRACT_MIGRATION_CHECKLIST = Object.freeze({
    tasks: 'pending',
    'quality-gate': 'pending',
    workflow: 'pending',
    'init-settings': 'pending',
    'project-memory': 'pending',
    backups: 'pending',
    instructions: 'pilot-migrated'
} as const);
