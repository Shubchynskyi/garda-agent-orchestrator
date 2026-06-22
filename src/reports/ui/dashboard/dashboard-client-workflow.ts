/** Browser-side dashboard script fragment (workflow). */
export const UI_DASHBOARD_CLIENT_WORKFLOW = `function syncWorkflowMessagesVisibility() {
  if (!workflowNode) {
    return;
  }
  workflowNode.hidden = workflowNode.innerHTML.trim() === '';
}
function updateWorkflowPanelTitle() {
  if (!workflowPanelTitleNode) {
    return;
  }
  workflowPanelTitleNode.textContent = settingGroupLabel(currentWorkflowSettingGroup);
}
function renderWorkflow(report) {
  const tab = report.workflow_config_tab;
  setPanelConfigPath(workflowConfigPathNode, tab && tab.config_path ? tab.config_path : '');
  const unavailable = tab && tab.unavailable ? tab.unavailable : [];
  if (unavailable.length > 0) {
    workflowNode.innerHTML = '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>';
    syncWorkflowMessagesVisibility();
    return;
  }
  const status = tab ? tab.status : 'missing';
  if (status === 'present') {
    workflowNode.innerHTML = '';
  } else {
    workflowNode.innerHTML = '<p class="workflow-state">' + safe(workflowStatusText(status)) + '</p>';
  }
  syncWorkflowMessagesVisibility();
}
function renderSettingResultMarkup(result) {
  const label = localizedField(settingTextPacks, result.setting_id, 'label', result.label || result.key || result.setting_id || t('setting'));
  return '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong></div>'
    + '<div class="command-preview-meta">'
    + '<span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span>'
    + '<span>' + safe(t('current')) + '<code>' + safe(JSON.stringify(result.current_value)) + '</code></span>'
    + '<span>' + safe(t('proposed')) + '<code>' + safe(JSON.stringify(result.proposed_value)) + '</code></span>'
    + '</div>'
    + (result.changed_keys && result.changed_keys.length > 0 ? '<p><strong>' + safe(t('changedKey')) + ':</strong> <code>' + safe(result.changed_keys.join(', ')) + '</code></p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
}
async function submitSetting(settingId, mode, value, confirmation, resultRenderer) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ setting_id: settingId, mode, value, confirmation })
  });
  const result = await response.json();
  if (typeof resultRenderer === 'function') {
    resultRenderer(result);
  }
  if (result && result.status === 'executed') {
    if (currentReport) {
      try {
        const reportResponse = await fetch('/api/report');
        const report = await reportResponse.json();
        currentReport = report;
        renderWorkflow(report);
      } catch {
        // Keep the successfully refreshed settings visible even if report refresh fails.
      }
    }
    await refreshSettingsPayload();
  }
}
function settingInputValue(setting) {
  if (setting && setting.id === 'compile-gate-command' && String(setting.current_value || '') === '__COMPILE_GATE_COMMAND_UNCONFIGURED__') {
    return '';
  }
  if (Array.isArray(setting.current_value)) {
    return setting.current_value.join(',');
  }
  if (typeof setting.current_value === 'boolean') {
    return String(setting.current_value);
  }
  return setting.current_value === null || setting.current_value === undefined ? '' : String(setting.current_value);
}
function settingValueList(setting) {
  if (Array.isArray(setting.current_value)) {
    return setting.current_value.map(value => String(value));
  }
  const inputValue = settingInputValue(setting);
  return inputValue.split(',').map(value => value.trim()).filter(Boolean);
}
function renderSettingOptions(setting) {
  if (!setting.options || setting.options.length === 0) {
    return '<div class="option-item"><strong>' + safe(t('noFixedOptions')) + '</strong><span>' + safe(t('freeValueHelp')) + '</span></div>';
  }
  if (setting.id === 'review-cycle-excluded-review-types') {
    const values = setting.options.map(option => String(option.value || '').trim()).filter(Boolean);
    return '<div class="option-list"><div class="option-item"><strong>' + safe(t('availableReviewTypes')) + '</strong><span><code>' + safe(values.join(', ')) + '</code></span></div></div>';
  }
  return '<div class="option-list">' + setting.options.map(option => '<div class="option-item"><strong>' + formatSettingOptionTitle(setting, option) + '</strong><span>' + inlineText(localizedOption(settingTextPacks, setting.id, option, 'description', option.description)) + '</span></div>').join('') + '</div>';
}
function settingControlId(settingId, controlScope) {
  return 'setting-input-' + (controlScope || 'workflow') + '-' + settingId;
}
function renderSettingControl(setting, disabled, controlScope) {
  const inputValue = settingInputValue(setting);
  const disabledAttr = disabled ? ' disabled' : '';
  const controlId = safe(settingControlId(setting.id, controlScope));
  if (isDurationMsSetting(setting)) {
    const parts = durationPartsFromMs(setting.current_value);
    return '<div class="duration-control" data-setting-id="' + safe(setting.id) + '"><label>' + safe(t('minutesLabel')) + '<input id="' + controlId + '-minutes" type="number" min="0" value="' + safe(parts.minutes) + '"' + disabledAttr + '></label><label>' + safe(t('secondsLabel')) + '<input id="' + controlId + '-seconds" type="number" min="0" max="59" value="' + safe(parts.seconds) + '"' + disabledAttr + '></label></div><span class="duration-help">' + safe(t('durationStoredAsMs')) + '</span>';
  }
  if (setting.value_type === 'enum_list' && setting.options && setting.options.length > 0) {
    const selected = new Set(settingValueList(setting));
    return '<div id="' + controlId + '" class="enum-list-control" role="group">' + setting.options.map(option => '<label><input type="checkbox" value="' + safe(option.value) + '"' + (selected.has(String(option.value)) ? ' checked' : '') + disabledAttr + '><span>' + formatSettingOptionTitle(setting, option) + '</span></label>').join('') + '</div>';
  }
  if (setting.options && setting.options.length > 0) {
    return '<select id="' + controlId + '"' + disabledAttr + '>' + setting.options.map(option => '<option value="' + safe(option.value) + '"' + (String(option.value) === inputValue ? ' selected' : '') + '>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' (' + safe(option.value) + ')</option>').join('') + '</select>';
  }
  if (setting.value_type === 'integer') {
    return '<input id="' + controlId + '" type="number" min="' + safe(setting.min || 1) + '" max="' + safe(setting.max || '') + '" value="' + safe(inputValue) + '"' + disabledAttr + '>';
  }
  return '<input id="' + controlId + '" type="text" value="' + safe(inputValue) + '" placeholder="' + safe(setting.placeholder || '') + '"' + disabledAttr + '>';
}
function settingGroupId(setting) {
  const key = String(setting.key || '');
  if (key.startsWith('full_suite_validation.')) return 'validation';
  if (key.startsWith('review_execution_policy.') || key.startsWith('review_cycle_guard.')) return 'review';
  if (key.startsWith('scope_budget_guard.')) return 'scope';
  if (key.startsWith('project_memory_maintenance.')) return 'memory';
  return 'safety';
}
function settingGroupLabel(groupId) {
  if (groupId === 'validation') return t('workflowGroupValidation');
  if (groupId === 'review') return t('workflowGroupReview');
  if (groupId === 'scope') return t('workflowGroupScope');
  if (groupId === 'memory') return t('workflowGroupMemory');
  return t('workflowGroupSafety');
}
function settingCurrentDisplay(setting) {
  if (setting && setting.id === 'compile-gate-command' && String(setting.current_value || '') === '__COMPILE_GATE_COMMAND_UNCONFIGURED__') {
    return localizedField(
      settingTextPacks,
      'compile-gate-command-fallback',
      'description',
      'Not set in workflow-config; compile-gate fails closed until workflow set records a project-specific compile/build/type-check command.'
    );
  }
  return isDurationMsSetting(setting) ? formatDurationMs(setting.current_value) : JSON.stringify(setting.current_value);
}
function settingReadinessNote(setting) {
  if (!setting || setting.id !== 'task-reset-enabled' || !setting.readiness) {
    return '';
  }
  const readiness = setting.readiness;
  const state = readiness.ready === true ? t('taskResetReady') : t('taskResetNotReady');
  const reason = readiness.disabled_reason ? '<div><code>' + safe(readiness.disabled_reason) + '</code></div>' : '';
  const remediation = readiness.remediation_command ? '<div>' + safe(t('taskResetRemediation')) + ' <code>' + safe(readiness.remediation_command) + '</code></div>' : '';
  return '<div class="setting-note"><strong>' + safe(state) + '</strong>' + reason + remediation + '</div>';
}
function settingLabelText(setting) {
  if (setting && setting.id === 'full-suite-timeout-warning-continuation') {
    return t('fullSuiteTimeoutWarningContinuation');
  }
  return localizedField(settingTextPacks, setting.id, 'label', setting.label);
}
function settingDescriptionText(setting) {
  if (setting && setting.id === 'full-suite-timeout-warning-continuation') {
    return t('fullSuiteTimeoutWarningContinuation') + ': ' + t('fullSuiteTimeoutBlocker');
  }
  return localizedField(settingTextPacks, setting.id, 'description', setting.description);
}
function renderSettingRow(setting, disabled, controlScope) {
  const label = settingLabelText(setting);
  const description = settingDescriptionText(setting);
  const dependencyNote = setting.id === 'review-cycle-auto-split-enabled'
    ? '<div class="setting-note">' + safe(t('reviewCycleAutoSplitDependency')) + '</div>'
    : '';
  const readinessNote = settingReadinessNote(setting);
  return '<tr>'
    + '<td><div class="setting-title"><strong>' + safe(label) + '</strong><code>(' + safe(setting.key) + ')</code><span class="setting-parameter"><code>' + safe(setting.flag) + '</code></span></div></td>'
    + '<td class="description-cell">' + inlineText(description) + dependencyNote + readinessNote + '</td>'
    + '<td><code class="current-value">' + safe(settingCurrentDisplay(setting)) + '</code></td>'
    + '<td>' + renderSettingOptions(setting) + '</td>'
    + '<td><label class="setting-control"><span>' + safe(t('newValue')) + '</span>' + renderSettingControl(setting, disabled, controlScope) + '</label><div class="setting-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-control-scope="' + safe(controlScope || 'workflow') + '" data-setting-mode="execute"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div></td>'
    + '</tr>';
}
function renderValidationRuntimeInfo(report) {
  if (currentWorkflowSettingGroup !== 'validation' || !report || !report.system_state || !report.system_state.workflow) {
    return '';
  }
  const workflow = report.system_state.workflow;
  return '<section class="workflow-group full-suite-runtime-info"><h3>' + safe(t('fullSuiteTitle')) + '</h3>'
    + '<div class="system-inline-details">'
    + '<span>' + safe(t('fullSuiteCommand')) + ': <code>' + safe(workflow.full_suite_command || '-') + '</code></span>'
    + '<span>' + safe(t('fullSuiteTimeoutBlocker')) + ': ' + safe(formatBool(workflow.full_suite_timeout_blocker)) + '</span>'
    + '<span>' + safe(t('fullSuiteTimeoutRetryCount')) + ': ' + safe(workflow.full_suite_timeout_retry_count == null ? '-' : String(workflow.full_suite_timeout_retry_count)) + '</span>'
    + '<span>' + safe(t('fullSuiteTimeoutAttempts')) + ': ' + safe(workflow.full_suite_timeout_attempts_count == null ? '-' : String(workflow.full_suite_timeout_attempts_count)) + ' / ' + safe(workflow.full_suite_timeout_max_attempts == null ? '-' : String(workflow.full_suite_timeout_max_attempts)) + '</span>'
    + '<span>' + safe(t('fullSuiteTimeoutAttemptsExhausted')) + ': ' + safe(formatBool(workflow.full_suite_timeout_attempts_exhausted)) + '</span>'
    + '<span>' + safe(t('fullSuiteTimeoutWarningContinuation')) + ': ' + safe(formatBool(workflow.full_suite_timeout_warning_only_continuation)) + '</span>'
    + '<span>' + safe(t('overviewWarnings')) + ': ' + safe(workflow.full_suite_timeout_latest_warning || '-') + '</span>'
    + '<span>' + safe(t('fullSuiteTimeoutForecast')) + ': ' + safe(workflow.full_suite_timeout_forecast_label || '-') + '</span>'
    + '</div></section>';
}
function validationBlockedTasks(report) {
  const rows = report && report.tasks_tab && report.tasks_tab.rows ? report.tasks_tab.rows : [];
  return rows.filter(task => (task.status_token || task.status) === 'BLOCKED');
}
function renderValidationActionButton(actionId) {
  const payload = currentActionsPayload;
  if (!payload || !payload.enabled) {
    return '';
  }
  const action = (payload.actions || []).find(item => item.id === actionId);
  if (!action || !action.enabled) {
    return '';
  }
  return '<button type="button" data-validation-action-id="' + safe(action.id) + '" data-validation-action-mode="execute">' + safe(actionLabel(action)) + '</button>';
}
function renderValidationChecksState(report) {
  if (currentWorkflowSettingGroup !== 'validation' || !report) {
    return '';
  }
  const blockedTasks = validationBlockedTasks(report);
  const warnings = report.unavailable || [];
  const fullSuite = currentTaskDetail && currentTaskDetail.full_suite_validation ? currentTaskDetail.full_suite_validation : null;
  const timeline = currentTaskDetail && currentTaskDetail.latest_cycle_events ? currentTaskDetail.latest_cycle_events : null;
  const actionsDisabled = !currentActionsPayload || !currentActionsPayload.enabled;
  const actionButtons = ['doctor', 'status-why-blocked'].map(renderValidationActionButton).join('');
  return '<section class="workflow-group validation-check-state">'
    + '<h3>' + safe(t('runtimeDiagnosticsTitle')) + '</h3>'
    + (actionsDisabled
      ? '<p class="empty">' + safe(t('actionsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('actionsDisabledTail')) + '</p>'
      : '<p class="empty">' + safe(t('actionsPreviewHelp')) + '</p><div class="action-buttons">' + actionButtons + '</div>')
    + '<div id="validation-action-status" class="action-status empty"></div>'
    + (blockedTasks.length > 0
      ? '<h3 class="task-section-title">' + safe(t('blockers')) + '</h3><ul class="list">' + blockedTasks.map(task => '<li><code>' + safe(task.task_id) + '</code>: ' + safe(task.title || task.area || '-') + '</li>').join('') + '</ul>'
      : '<p class="empty">' + safe(t('noBlockers')) + '</p>')
    + (warnings.length > 0
      ? '<h3 class="task-section-title">' + safe(t('warningsTitle')) + '</h3><ul class="list">' + warnings.map(item => '<li><code>' + safe(item.scope || '-') + '</code>: ' + safe(item.reason || item.message || item) + '</li>').join('') + '</ul>'
      : '<p class="empty">' + safe(t('noRuntimeDiagnostics')) + '</p>')
    + (fullSuite ? '<h3 class="task-section-title">' + safe(t('fullSuiteState')) + '</h3>' + fullSuiteSummary(fullSuite) : '')
    + (timeline ? '<h3 class="task-section-title">' + safe(t('gateTimeline')) + '</h3><p class="empty">' + safe(t('gateTimelineHelp')) + '</p><pre>' + safe(JSON.stringify(timeline, null, 2)) + '</pre>' : '')
    + '</section>';
}
async function runValidationAction(actionId, mode) {
  const response = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode })
  });
  const result = await response.json();
  const node = document.getElementById('validation-action-status');
  if (!node) {
    return;
  }
  const label = localizedField(actionTextPacks, result.action_id || actionId, 'label', result.action_id || actionId || t('action'));
  node.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
  focusVisibleActionResult(node);
}
function renderSettingsEditor(payload) {
  currentSettingsPayload = payload;
  const settings = payload.settings || [];
  if (settings.length === 0) {
    updateWorkflowPanelTitle();
    settingsEditorNode.innerHTML = '<p class="empty">' + safe(t('noEditableSettings')) + '</p>';
    syncWorkflowMessagesVisibility();
    return;
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '';
  const groupOrder = ['validation', 'review', 'scope', 'safety'];
  const availableGroups = groupOrder.filter(groupId => settings.some(setting => settingGroupId(setting) === groupId));
  if (!availableGroups.includes(currentWorkflowSettingGroup)) {
    currentWorkflowSettingGroup = availableGroups[0] || 'validation';
  }
  updateWorkflowPanelTitle();
  const reportForRuntimeInfo = typeof currentReport === 'undefined' ? null : currentReport;
  settingsEditorNode.innerHTML = disabledNotice
    + renderValidationChecksState(reportForRuntimeInfo)
    + renderValidationRuntimeInfo(reportForRuntimeInfo)
    + (() => {
      const groupSettings = settings.filter(setting => settingGroupId(setting) === currentWorkflowSettingGroup);
      if (groupSettings.length === 0) return '<p class="empty">' + safe(t('noWorkflowSettings')) + '</p>';
      return '<section class="workflow-group workflow-setting-group"><div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + groupSettings.map(setting => renderSettingRow(setting, disabled, 'workflow')).join('') + '</tbody></table></div></section>';
    })();
  syncWorkflowMessagesVisibility();
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const controlScope = button.dataset.settingControlScope || 'workflow';
      const input = document.getElementById(settingControlId(button.dataset.settingId, controlScope));
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, settingSubmitValue(setting, input, controlScope), confirmation);
    });
  }
  for (const button of settingsEditorNode.querySelectorAll('button[data-validation-action-id]')) {
    button.addEventListener('click', () => {
      runValidationAction(button.dataset.validationActionId, button.dataset.validationActionMode || 'execute');
    });
  }
}
async function refreshSettingsPayload() {
  const response = await fetch('/api/settings');
  renderSettingsEditor(await response.json());
  if (currentReport) {
    renderProjectMemory(currentReport);
  }
}
function settingSubmitValue(setting, fallbackInput, controlScope) {
  if (isDurationMsSetting(setting)) {
    const baseControlId = settingControlId(setting.id, controlScope || 'workflow');
    const minutesInput = document.getElementById(baseControlId + '-minutes');
    const secondsInput = document.getElementById(baseControlId + '-seconds');
    const minutes = Math.max(0, Math.trunc(Number(minutesInput ? minutesInput.value : 0) || 0));
    const seconds = Math.max(0, Math.min(59, Math.trunc(Number(secondsInput ? secondsInput.value : 0) || 0)));
    return String((minutes * 60 + seconds) * 1000);
  }
  if (setting && setting.value_type === 'enum_list') {
    return Array.from((fallbackInput || document).querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
  }
  return fallbackInput ? fallbackInput.value : '';
}
`;
