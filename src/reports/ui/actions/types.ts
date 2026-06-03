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
    confirmation_phrase: string;
}

export interface UiActionRunnerResult {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
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
    error?: string;
}

export interface ParsedUiSettingValue {
    command_value: string;
    proposed_value: unknown;
}
