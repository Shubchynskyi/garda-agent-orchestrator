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
function qualityGateEvidenceLabel(status) {
  if (status === 'stale') return t('qualityGateEvidenceStale');
  if (status === 'missing') return t('qualityGateEvidenceMissing');
  if (status === 'invalid') return t('qualityGateEvidenceInvalid');
  if (status === 'disabled') return t('qualityGateEffectDisabled');
  return t('qualityGateEvidenceCurrent');
}
function qualityGateEffectLabel(effect) {
  if (effect === 'helped') return t('qualityGateEffectHelped');
  if (effect === 'warned') return t('qualityGateEffectWarned');
  if (effect === 'required_rework') return t('qualityGateEffectRequiredRework');
  if (effect === 'disabled') return t('qualityGateEffectDisabled');
  if (effect === 'missing') return t('qualityGateEffectMissing');
  if (effect === 'invalid') return t('qualityGateEffectInvalid');
  if (effect === 'stale') return t('qualityGateEffectStale');
  return t('qualityGateEffectPassed');
}
function qualityGateStatusBadges(rule) {
  const statuses = Array.isArray(rule.statuses) && rule.statuses.length > 0 ? rule.statuses : ['active'];
  return statuses.map(status => badge(qualityGateStatusLabel(status), 'quality-gate-rule', 'quality-gate-rule-' + classToken(status))).join(' ');
}
function renderQualityGateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<span class="muted">-</span>';
  }
  return '<ul class="quality-gate-items">' + items.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>';
}
function qualityGateMetricHtml(label, valueHtml) {
  return '<div class="metric"><span>' + safe(label) + '</span><strong>' + valueHtml + '</strong></div>';
}
function renderQualityGateAnswerSummaries(answers) {
  const entries = Array.isArray(answers) ? answers : [];
  if (entries.length === 0) {
    return '';
  }
  return '<div class="quality-gate-answer-summary"><strong>' + safe(t('qualityGateAnswers')) + '</strong><ul class="quality-gate-answer-list">'
    + entries.map(answer => {
      const evidence = Array.isArray(answer.evidence_files) && answer.evidence_files.length > 0
        ? '<div><span class="muted">' + safe(t('qualityGateChangedFiles')) + '</span>' + renderQualityGateItems(answer.evidence_files) + '</div>'
        : '';
      const taken = Array.isArray(answer.actions_taken) && answer.actions_taken.length > 0
        ? '<div><span class="muted">' + safe(t('qualityGateActionsTaken')) + '</span>' + renderQualityGateItems(answer.actions_taken) + '</div>'
        : '';
      const required = Array.isArray(answer.actions_required) && answer.actions_required.length > 0
        ? '<div><span class="muted">' + safe(t('qualityGateActionsRequired')) + '</span>' + renderQualityGateItems(answer.actions_required) + '</div>'
        : '';
      return '<li><div class="quality-gate-answer-head"><code>' + safe(answer.rule_id || '-') + '</code>'
        + badge(answer.status || '-', 'quality-gate-answer-status', 'quality-gate-answer-status-' + classToken(answer.status))
        + '</div><p>' + safe(answer.answer || '-') + '</p>' + evidence + taken + required + '</li>';
    }).join('')
    + '</ul></div>';
}
function renderQualityGateLatestCheck(check) {
  if (!check) {
    return '';
  }
  const changedFiles = check.changed_files_count == null
    ? '-'
    : String(check.changed_files_count) + (check.changed_files_truncated ? ' +' : '');
  return '<section class="quality-gate-block quality-gate-evidence"><h3>' + safe(t('qualityGateLatestCheck')) + '</h3>'
    + '<div class="quality-gate-summary">'
    + qualityGateMetricHtml(t('qualityGateEvidenceState'), badge(qualityGateEvidenceLabel(check.evidence_status), 'quality-gate-evidence-state', 'quality-gate-evidence-' + classToken(check.evidence_status)))
    + qualityGateMetricHtml(t('qualityGateEffect'), badge(qualityGateEffectLabel(check.effect), 'quality-gate-effect-state', 'quality-gate-effect-' + classToken(check.effect)))
    + metric(t('statusColumn'), check.checklist_status || '-')
    + metric(t('qualityGateAnswers'), check.answer_count)
    + metric(t('qualityGateActionsTaken'), check.action_taken_count)
    + metric(t('qualityGateActionsRequired'), check.action_required_count)
    + metric(t('qualityGateChangedFiles'), changedFiles)
    + metric(t('qualityGateTimelineEvents'), check.timeline_event_count)
    + '</div>'
    + '<p class="quality-gate-evidence-summary">' + safe(check.summary || '') + '</p>'
    + (Array.isArray(check.stale_reasons) && check.stale_reasons.length > 0 ? '<div class="blocker-alert">' + renderQualityGateItems(check.stale_reasons) + '</div>' : '')
    + renderQualityGateAnswerSummaries(check.answers)
    + (Array.isArray(check.actions_required) && check.actions_required.length > 0 ? '<div><strong>' + safe(t('qualityGateActionsRequired')) + '</strong>' + renderQualityGateItems(check.actions_required) + '</div>' : '')
    + (Array.isArray(check.actions_taken) && check.actions_taken.length > 0 ? '<div><strong>' + safe(t('qualityGateActionsTaken')) + '</strong>' + renderQualityGateItems(check.actions_taken) + '</div>' : '')
    + (Array.isArray(check.changed_files_preview) && check.changed_files_preview.length > 0 ? '<div><strong>' + safe(t('qualityGateChangedFiles')) + '</strong>' + renderQualityGateItems(check.changed_files_preview) + '</div>' : '')
    + '</section>';
}
function renderQualityGateActionHistory(history) {
  const entries = Array.isArray(history) ? history : [];
  if (entries.length === 0) {
    return '<section class="quality-gate-block"><h3>' + safe(t('qualityGateActionRequiredHistory')) + '</h3><p class="empty">' + safe(t('qualityGateNoActionRequiredHistory')) + '</p></section>';
  }
  return '<section class="quality-gate-block"><h3>' + safe(t('qualityGateActionRequiredHistory')) + '</h3><div class="workflow-table"><table><thead><tr><th>' + safe(t('idColumn')) + '</th><th>' + safe(t('qualityGateEvidenceState')) + '</th><th>' + safe(t('qualityGateActionsRequired')) + '</th><th>' + safe(t('qualityGateChangedFiles')) + '</th><th>' + safe(t('fileColumn')) + '</th></tr></thead><tbody>'
    + entries.map(entry => '<tr><td><code>' + safe(entry.task_id || '-') + '</code></td><td>' + badge(qualityGateEvidenceLabel(entry.evidence_status), 'quality-gate-evidence-state', 'quality-gate-evidence-' + classToken(entry.evidence_status)) + '</td><td>' + renderQualityGateItems(entry.actions_required) + '</td><td>' + safe(String(entry.changed_files_count == null ? '-' : entry.changed_files_count)) + '</td><td><code>' + safe(entry.artifact_path || '-') + '</code></td></tr>').join('')
    + '</tbody></table></div></section>';
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
    + renderQualityGateLatestCheck(tab.latest_check)
    + renderQualityGateActionHistory(tab.action_required_history)
    + renderQualityGateToggle(settingsPayload.settings || [], disabled)
    + '<section class="quality-gate-block"><h3>' + safe(t('qualityGateRuleSet')) + '</h3>'
    + (rules.length === 0 ? '<p class="empty">' + safe(t('qualityGateRulesEmpty')) + '</p>' : '<div class="workflow-table"><table><thead><tr><th>' + safe(t('idColumn')) + '</th><th>' + safe(t('qualityGateSourceColumn')) + '</th><th>' + safe(t('statusColumn')) + '</th><th>' + safe(t('titleColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('gardaSwitchState')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + rules.map(rule => renderQualityGateRuleRow(rule, disabled)).join('') + renderQualityGateNewRuleRow(disabled) + '</tbody></table></div>')
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
