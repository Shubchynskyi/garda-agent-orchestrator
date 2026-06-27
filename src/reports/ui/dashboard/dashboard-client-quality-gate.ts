/** Browser-side dashboard script fragment (quality gate). */
export const UI_DASHBOARD_CLIENT_QUALITY_GATE = `function qualityGatePayload() {
  if (currentSettingsPayload && currentSettingsPayload.quality_gate) {
    return currentSettingsPayload.quality_gate;
  }
  return currentReport ? currentReport.quality_gate_tab : null;
}
function qualityGateStatusLabel(status) {
  if (status === 'disabled') return t('qualityGateStatusDisabled');
  if (status === 'locally_edited') return t('qualityGateStatusLocallyEdited');
  if (status === 'deleted') return t('qualityGateStatusDeleted');
  return t('qualityGateStatusActive');
}
function qualityGateSourceLabel(source) {
  return source === 'custom' ? t('qualityGateSourceCustom') : t('qualityGateSourceBaseline');
}
function qualityGateStatusBadges(rule) {
  const statuses = Array.isArray(rule.statuses) && rule.statuses.length > 0 ? rule.statuses : ['active'];
  return statuses.map(status => badge(qualityGateStatusLabel(status), 'quality-gate-rule', 'quality-gate-rule-' + classToken(status))).join(' ');
}
function renderQualityGateResult(result) {
  currentQualityGateSettingResult = result;
  if (!qualityGateStatusNode) {
    return;
  }
  qualityGateStatusNode.innerHTML = renderSettingResultMarkup(result);
  if (qualityGateStatusNode.classList && typeof qualityGateStatusNode.classList.toggle === 'function') {
    qualityGateStatusNode.classList.toggle('empty', false);
  }
  if (typeof qualityGateStatusNode.setAttribute === 'function' && (!qualityGateStatusNode.getAttribute || qualityGateStatusNode.getAttribute('tabindex') === null)) {
    qualityGateStatusNode.setAttribute('tabindex', '-1');
  }
  if (typeof qualityGateStatusNode.scrollIntoView === 'function') {
    qualityGateStatusNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (typeof qualityGateStatusNode.focus === 'function') {
    qualityGateStatusNode.focus({ preventScroll: true });
  }
}
function renderQualityGateToggle(settings, disabled) {
  const setting = (settings || []).find(item => item.id === 'optional-checks-enabled');
  if (!setting) {
    return '';
  }
  return '<section class="quality-gate-block"><div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>'
    + '<tr><td><strong>' + safe(settingLabelText(setting)) + '</strong><code>(' + safe(setting.key) + ')</code></td><td>' + inlineText(settingDescriptionText(setting)) + '</td><td><code class="current-value">' + safe(settingCurrentDisplay(setting)) + '</code></td><td><label class="setting-control"><span>' + safe(t('newValue')) + '</span>' + renderSettingControl(setting, disabled, 'quality-gate') + '</label><div class="setting-buttons"><button type="button" data-quality-gate-setting-id="' + safe(setting.id) + '" data-setting-mode="execute"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div></td></tr>'
    + '</tbody></table></div></section>';
}
function renderQualityGateRuleRow(rule, disabled) {
  const ruleId = safe(rule.id || '');
  const baselineRule = rule.source === 'baseline';
  const disabledAttr = disabled ? ' disabled' : '';
  const immutableTextAttr = disabled || baselineRule ? ' disabled' : '';
  const deleteDisabledAttr = disabled || baselineRule || rule.present === false ? ' disabled' : '';
  const source = qualityGateSourceLabel(rule.source);
  const actionLabel = rule.present === false ? t('addOptionalCheckRule') : t('saveOptionalCheckRule');
  return '<tr data-optional-rule-id="' + ruleId + '">'
    + '<td><code>' + ruleId + '</code></td>'
    + '<td>' + safe(source) + '</td>'
    + '<td>' + qualityGateStatusBadges(rule) + '</td>'
    + '<td><input id="' + safe(optionalRuleInputId(rule.id, 'title')) + '" type="text" value="' + safe(optionalRuleValue(rule, 'title')) + '"' + immutableTextAttr + '></td>'
    + '<td><input id="' + safe(optionalRuleInputId(rule.id, 'prompt')) + '" type="text" value="' + safe(optionalRuleValue(rule, 'prompt')) + '"' + immutableTextAttr + '></td>'
    + '<td><select id="' + safe(optionalRuleInputId(rule.id, 'enabled')) + '"' + disabledAttr + '><option value="true"' + (rule.enabled !== false ? ' selected' : '') + '>' + safe(t('gardaSwitchStateOn')) + '</option><option value="false"' + (rule.enabled === false ? ' selected' : '') + '>' + safe(t('gardaSwitchStateOff')) + '</option></select></td>'
    + '<td><div class="setting-buttons"><button type="button" data-quality-gate-rule-action="upsert" data-quality-gate-rule-id="' + ruleId + '"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : actionLabel) + '</button><button type="button" data-quality-gate-rule-action="delete" data-quality-gate-rule-id="' + ruleId + '"' + deleteDisabledAttr + '>' + safe(t('removeOptionalCheckRule')) + '</button></div></td>'
    + '</tr>';
}
function renderQualityGateNewRuleRow(disabled) {
  const disabledAttr = disabled ? ' disabled' : '';
  const newId = optionalRuleInputId('quality-gate-new', 'id');
  const newTitle = optionalRuleInputId('quality-gate-new', 'title');
  const newPrompt = optionalRuleInputId('quality-gate-new', 'prompt');
  const newEnabled = optionalRuleInputId('quality-gate-new', 'enabled');
  return '<tr data-optional-rule-id="quality-gate-new"><td><input id="' + safe(newId) + '" type="text" placeholder="custom_rule_id"' + disabledAttr + '></td><td>' + safe(t('qualityGateSourceCustom')) + '</td><td>' + badge(t('qualityGateNewRule'), 'quality-gate-rule', 'quality-gate-rule-new') + '</td><td><input id="' + safe(newTitle) + '" type="text"' + disabledAttr + '></td><td><input id="' + safe(newPrompt) + '" type="text"' + disabledAttr + '></td><td><select id="' + safe(newEnabled) + '"' + disabledAttr + '><option value="true">' + safe(t('gardaSwitchStateOn')) + '</option><option value="false">' + safe(t('gardaSwitchStateOff')) + '</option></select></td><td><div class="setting-buttons"><button type="button" data-quality-gate-rule-action="upsert" data-quality-gate-rule-id="quality-gate-new"' + (disabled ? ' disabled' : '') + '>' + safe(t('addOptionalCheckRule')) + '</button></div></td></tr>';
}
function renderQualityGateRuleRows(rules, disabled) {
  const customRules = rules.filter(rule => rule.source === 'custom');
  const baselineRules = rules.filter(rule => rule.source !== 'custom');
  return renderQualityGateNewRuleRow(disabled)
    + customRules.map(rule => renderQualityGateRuleRow(rule, disabled)).join('')
    + baselineRules.map(rule => renderQualityGateRuleRow(rule, disabled)).join('');
}
function readQualityGateRuleForm(ruleId) {
  const formId = ruleId === 'quality-gate-new' ? 'quality-gate-new' : ruleId;
  const actualId = ruleId === 'quality-gate-new'
    ? (document.getElementById(optionalRuleInputId('quality-gate-new', 'id')) || {}).value
    : ruleId;
  const titleInput = document.getElementById(optionalRuleInputId(formId, 'title'));
  const promptInput = document.getElementById(optionalRuleInputId(formId, 'prompt'));
  const enabledInput = document.getElementById(optionalRuleInputId(formId, 'enabled'));
  return {
    id: actualId || '',
    title: titleInput ? titleInput.value : '',
    prompt: promptInput ? promptInput.value : '',
    enabled: enabledInput ? enabledInput.value : 'true'
  };
}
function renderQualityGate(report) {
  const tab = qualityGatePayload() || (report ? report.quality_gate_tab : null);
  setPanelConfigPath(qualityGateConfigPathNode, tab && tab.config_path ? tab.config_path : '');
  if (!qualityGateNode) {
    return;
  }
  if (!tab) {
    qualityGateNode.innerHTML = '<p class="empty">' + safe(t('loading')) + '</p>';
    return;
  }
  const settingsPayload = currentSettingsPayload || {};
  const disabled = !settingsPayload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '';
  const unavailable = Array.isArray(tab.unavailable) ? tab.unavailable : [];
  const warning = unavailable.length > 0
    ? '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>'
    : '';
  const rules = Array.isArray(tab.rules) ? tab.rules : [];
  qualityGateNode.innerHTML = warning
    + disabledNotice
    + '<section class="quality-gate-summary">'
    + metric(t('gardaSwitchState'), tab.enabled ? t('gardaSwitchStateOn') : t('gardaSwitchStateOff'))
    + metric(t('qualityGateBaselineRules'), tab.baseline_rule_count)
    + metric(t('qualityGateCustomRules'), tab.custom_rule_count)
    + '</section>'
    + renderQualityGateToggle(settingsPayload.settings || [], disabled)
    + '<section class="quality-gate-block"><h3>' + safe(t('qualityGateRuleSet')) + '</h3>'
    + (rules.length === 0 ? '<p class="empty">' + safe(t('qualityGateRulesEmpty')) + '</p>' : '<div class="workflow-table quality-gate-rule-table"><table><thead><tr><th>' + safe(t('idColumn')) + '</th><th>' + safe(t('qualityGateSourceColumn')) + '</th><th>' + safe(t('statusColumn')) + '</th><th>' + safe(t('titleColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('gardaSwitchState')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + renderQualityGateRuleRows(rules, disabled) + '</tbody></table></div>')
    + '</section>';
  for (const button of qualityGateNode.querySelectorAll('button[data-quality-gate-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = (settingsPayload.settings || []).find(item => item.id === button.dataset.qualityGateSettingId);
      const input = document.getElementById(settingControlId(button.dataset.qualityGateSettingId, 'quality-gate'));
      const confirmation = setting ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail')) : null;
      if (confirmation === null) {
        return;
      }
      submitSetting(button.dataset.qualityGateSettingId, button.dataset.settingMode || 'execute', settingSubmitValue(setting, input, 'quality-gate'), confirmation, renderQualityGateResult);
    });
  }
  for (const button of qualityGateNode.querySelectorAll('button[data-quality-gate-rule-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.qualityGateRuleAction;
      const form = readQualityGateRuleForm(button.dataset.qualityGateRuleId || '');
      const confirmation = window.prompt(t('typeToApplySetting') + ' "APPLY GARDA SETTING" ' + t('typeToApplySettingTail'));
      if (confirmation === null) {
        return;
      }
      submitOptionalRule(action, form.id, form.title, form.prompt, form.enabled, confirmation, renderQualityGateResult);
    });
  }
}
`;
