export type UiActionMode = 'preview' | 'execute';

export interface UiActionCommand {
    executable: string;
    args: string[];
    display: string;
}

export interface UiActionDefinition {
    id: string;
    category: string;
    label: string;
    description: string;
    mutates: boolean;
    enabled: boolean;
    unavailable_reason: string | null;
    requires_confirmation: boolean;
    confirmation_phrase: string | null;
    timeout_ms: number;
    command: UiActionCommand;
}

export type UiSwitchModeState = 'on' | 'off' | 'unknown';

export interface UiSettingDefinition {
    id: string;
    key: string;
    label: string;
    description: string;
    flag: string;
    current_value: unknown;
    value_type: import('../../workflow-setting-metadata').WorkflowSettingValueType;
    options: import('../../workflow-setting-metadata').WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
    command_value_inverts_boolean?: boolean;
    compile_gate_full_suite_command?: string | null;
    confirmation_phrase: string;
    readiness?: import('../../report-data/types').ReportWorkflowSetting['readiness'];
}

export interface UiActionRunnerResult {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timed_out?: boolean;
    timeout_ms?: number;
}

export type UiActionRunner = (action: UiActionDefinition, repoRoot: string) => Promise<UiActionRunnerResult>;

export interface UiActionAuditRecord {
    timestamp_utc: string;
    action_id: string;
    mode: UiActionMode;
    status: string;
    command: string;
    exit_code?: number | null;
    signal?: string | null;
    timed_out?: boolean;
    timeout_ms?: number;
    error?: string;
}

export interface ParsedUiSettingValue {
    command_value: string;
    proposed_value: unknown;
}

export type UiOptionalCheckRuleAction = 'upsert' | 'delete';

export interface ParsedUiOptionalCheckRuleValue {
    action: UiOptionalCheckRuleAction;
    rule_id: string;
    title: string | null;
    prompt: string | null;
    enabled: boolean | null;
    proposed_value: unknown;
    command_args: string[];
}
