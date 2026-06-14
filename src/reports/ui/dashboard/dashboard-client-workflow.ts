/** Browser-side dashboard script fragment (workflow). */
export const UI_DASHBOARD_CLIENT_WORKFLOW = `function renderWorkflow(report) {
  const tab = report.workflow_config_tab;
  workflowConfigPathNode.textContent = tab && tab.config_path ? '(' + tab.config_path + ')' : '';
  const unavailable = tab && tab.unavailable ? tab.unavailable : [];
  if (unavailable.length > 0) {
    workflowNode.innerHTML = '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>';
    return;
  }
  workflowNode.innerHTML = '<p class="workflow-state">' + safe(workflowStatusText(tab ? tab.status : 'missing')) + '</p>';
}
function renderSettingResult(result) {
  currentSettingResult = result;
  const label = localizedField(settingTextPacks, result.setting_id, 'label', result.label || result.key || result.setting_id || t('setting'));
  settingStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3>'
    + '<p class="empty">' + safe(t('workflowCommandPreviewHelp')) + '</p>'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong><br><code>' + safe(result.command || '-') + '</code></div>'
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
async function submitSetting(settingId, mode, value, confirmation) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ setting_id: settingId, mode, value, confirmation })
  });
  const result = await response.json();
  renderSettingResult(result);
  if (result && result.status === 'executed') {
    await refreshSettingsPayload();
    if (currentReport) {
      fetch('/api/report').then(reportResponse => reportResponse.json()).then(report => {
        currentReport = report;
        renderWorkflow(report);
      }).catch(() => undefined);
    }
  }
}
function settingInputValue(setting) {
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
  return '<div class="option-list">' + setting.options.map(option => '<div class="option-item"><strong>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' <code>' + safe(option.value) + '</code></strong><span>' + inlineText(localizedOption(settingTextPacks, setting.id, option, 'description', option.description)) + '</span></div>').join('') + '</div>';
}
function renderSettingControl(setting, disabled) {
  const inputValue = settingInputValue(setting);
  const disabledAttr = disabled ? ' disabled' : '';
  const controlId = 'setting-input-' + safe(setting.id);
  if (isDurationMsSetting(setting)) {
    const parts = durationPartsFromMs(setting.current_value);
    return '<div class="duration-control" data-setting-id="' + safe(setting.id) + '"><label>' + safe(t('minutesLabel')) + '<input id="' + controlId + '-minutes" type="number" min="0" value="' + safe(parts.minutes) + '"' + disabledAttr + '></label><label>' + safe(t('secondsLabel')) + '<input id="' + controlId + '-seconds" type="number" min="0" max="59" value="' + safe(parts.seconds) + '"' + disabledAttr + '></label></div><span class="duration-help">' + safe(t('durationStoredAsMs')) + '</span>';
  }
  if (setting.value_type === 'enum_list' && setting.options && setting.options.length > 0) {
    const selected = new Set(settingValueList(setting));
    return '<div id="' + controlId + '" class="enum-list-control" role="group">' + setting.options.map(option => '<label><input type="checkbox" value="' + safe(option.value) + '"' + (selected.has(String(option.value)) ? ' checked' : '') + disabledAttr + '><span>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' <code>' + safe(option.value) + '</code></span></label>').join('') + '</div>';
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
function renderSettingRow(setting, disabled) {
  const label = localizedField(settingTextPacks, setting.id, 'label', setting.label);
  const description = localizedField(settingTextPacks, setting.id, 'description', setting.description);
  const dependencyNote = setting.id === 'review-cycle-auto-split-enabled'
    ? '<div class="setting-note">' + safe(t('reviewCycleAutoSplitDependency')) + '</div>'
    : '';
  return '<tr>'
    + '<td><div class="setting-title"><strong>' + safe(label) + '</strong><code>(' + safe(setting.key) + ')</code><span class="setting-parameter"><code>' + safe(setting.flag) + '</code></span></div></td>'
    + '<td class="description-cell">' + inlineText(description) + dependencyNote + '</td>'
    + '<td><code class="current-value">' + safe(isDurationMsSetting(setting) ? formatDurationMs(setting.current_value) : JSON.stringify(setting.current_value)) + '</code></td>'
    + '<td>' + renderSettingOptions(setting) + '</td>'
    + '<td><label class="setting-control"><span>' + safe(t('newValue')) + '</span>' + renderSettingControl(setting, disabled) + '</label><div class="setting-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="preview"' + (disabled ? ' disabled' : '') + '>' + safe(t('previewCommand')) + '</button><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="execute"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div></td>'
    + '</tr>';
}
function renderSettingsEditor(payload) {
  currentSettingsPayload = payload;
  const settings = payload.settings || [];
  if (settings.length === 0) {
    settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3><p class="empty">' + safe(t('noEditableSettings')) + '</p>';
    return;
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '<p class="empty">' + safe(t('guardedEditorHelp')) + '</p>';
  const groupOrder = ['validation', 'review', 'scope', 'memory', 'safety'];
  if (!currentSettingResult) {
    settingStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3><p class="empty">' + safe(t('workflowCommandPreviewHelp')) + '</p></section>';
  }
  settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3>' + disabledNotice
    + groupOrder.map(groupId => {
      const groupSettings = settings.filter(setting => settingGroupId(setting) === groupId);
      if (groupSettings.length === 0) return '';
      return '<section class="workflow-group"><h3>' + safe(settingGroupLabel(groupId)) + '</h3><div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + groupSettings.map(setting => renderSettingRow(setting, disabled)).join('') + '</tbody></table></div></section>';
    }).join('');
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const input = document.getElementById('setting-input-' + button.dataset.settingId);
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, settingSubmitValue(setting, input), confirmation);
    });
  }
}
async function refreshSettingsPayload() {
  const response = await fetch('/api/settings');
  renderSettingsEditor(await response.json());
}
function settingSubmitValue(setting, fallbackInput) {
  if (isDurationMsSetting(setting)) {
    const minutesInput = document.getElementById('setting-input-' + setting.id + '-minutes');
    const secondsInput = document.getElementById('setting-input-' + setting.id + '-seconds');
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
