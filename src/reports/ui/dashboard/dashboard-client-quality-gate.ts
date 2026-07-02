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
function qualityGateRulePackLabel(tab, labelField, rawField) {
  return tab && tab[labelField] ? tab[labelField] : formatQualityRulePackVersion(tab && tab[rawField]);
}
function qualityGateListValue(values) {
  const items = Array.isArray(values) ? values.map(item => String(item || '').trim()).filter(Boolean) : [];
  return items.length > 0 ? items.join(', ') : '-';
}
function qualityGateEvidenceLabel(status) {
  if (status === 'current') return t('qualityGateEvidenceCurrent');
  if (status === 'stale') return t('qualityGateEvidenceStale');
  if (status === 'missing') return t('qualityGateEvidenceMissing');
  if (status === 'invalid') return t('qualityGateEvidenceInvalid');
  return status || '-';
}
function qualityGateEffectLabel(effect) {
  if (effect === 'passed') return t('qualityGateEffectPassed');
  if (effect === 'helped') return t('qualityGateEffectHelped');
  if (effect === 'warned') return t('qualityGateEffectWarned');
  if (effect === 'required_rework') return t('qualityGateEffectRequiredRework');
  if (effect === 'disabled') return t('qualityGateEffectDisabled');
  if (effect === 'missing') return t('qualityGateEffectMissing');
  if (effect === 'invalid') return t('qualityGateEffectInvalid');
  if (effect === 'stale') return t('qualityGateEffectStale');
  return effect || '-';
}
function renderQualityGateSkippedByScopeRules(latest) {
  const rules = latest && Array.isArray(latest.skipped_by_scope_rules) ? latest.skipped_by_scope_rules : [];
  if (rules.length === 0) {
    return '<p class="empty">No rules were skipped by scope.</p>';
  }
  return '<div class="workflow-table"><table><thead><tr><th>' + safe(t('idColumn')) + '</th><th>' + safe(t('titleColumn')) + '</th><th>' + safe('Excluded scopes') + '</th><th>' + safe('Skip reason') + '</th></tr></thead><tbody>'
    + rules.map(rule => '<tr><td><code>' + safe(rule.rule_id || '') + '</code></td><td>' + safe(rule.title || '') + '</td><td><code>' + safe(qualityGateListValue(rule.excluded_scope_categories)) + '</code></td><td>' + safe(rule.scope_skip_reason || '-') + '</td></tr>').join('')
    + '</tbody></table></div>';
}
function renderQualityGateLatestCheck(latest) {
  if (!latest) {
    return '';
  }
  return '<section class="quality-gate-block"><h3>' + safe(t('qualityGateLatestCheck')) + '</h3>'
    + '<section class="quality-gate-summary">'
    + metric(t('qualityGateEvidenceState'), qualityGateEvidenceLabel(latest.evidence_status))
    + metric(t('qualityGateEffect'), qualityGateEffectLabel(latest.effect))
    + metric('Scope', latest.scope_category || '-')
    + metric(t('qualityGateChangedFiles'), latest.changed_files_count)
    + metric('Enabled rules', latest.enabled_rule_count)
    + metric('Active rules', latest.active_rule_count)
    + metric('Skipped by scope', latest.skipped_by_scope_rule_count)
    + metric(t('qualityGateAnswers'), latest.answer_count)
    + metric(t('qualityGateActionsRequired'), latest.action_required_count)
    + '</section>'
    + (latest.summary ? '<p class="empty">' + safe(latest.summary) + '</p>' : '')
    + '<h4>' + safe('Skipped by scope') + '</h4>'
    + renderQualityGateSkippedByScopeRules(latest)
    + '</section>';
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
    + '<td><code>' + safe(qualityGateListValue(rule.excluded_scope_categories)) + '</code></td>'
    + '<td><div class="setting-buttons"><button type="button" data-quality-gate-rule-action="upsert" data-quality-gate-rule-id="' + ruleId + '"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : actionLabel) + '</button><button type="button" data-quality-gate-rule-action="delete" data-quality-gate-rule-id="' + ruleId + '"' + deleteDisabledAttr + '>' + safe(t('removeOptionalCheckRule')) + '</button></div></td>'
    + '</tr>';
}
function renderQualityGateNewRuleRow(disabled) {
  const disabledAttr = disabled ? ' disabled' : '';
  const newId = optionalRuleInputId('quality-gate-new', 'id');
  const newTitle = optionalRuleInputId('quality-gate-new', 'title');
  const newPrompt = optionalRuleInputId('quality-gate-new', 'prompt');
  const newEnabled = optionalRuleInputId('quality-gate-new', 'enabled');
  return '<tr data-optional-rule-id="quality-gate-new"><td><input id="' + safe(newId) + '" type="text" placeholder="custom_rule_id"' + disabledAttr + '></td><td>' + safe(t('qualityGateSourceCustom')) + '</td><td>' + badge(t('qualityGateNewRule'), 'quality-gate-rule', 'quality-gate-rule-new') + '</td><td><input id="' + safe(newTitle) + '" type="text"' + disabledAttr + '></td><td><input id="' + safe(newPrompt) + '" type="text"' + disabledAttr + '></td><td><select id="' + safe(newEnabled) + '"' + disabledAttr + '><option value="true">' + safe(t('gardaSwitchStateOn')) + '</option><option value="false">' + safe(t('gardaSwitchStateOff')) + '</option></select></td><td><code>-</code></td><td><div class="setting-buttons"><button type="button" data-quality-gate-rule-action="upsert" data-quality-gate-rule-id="quality-gate-new"' + (disabled ? ' disabled' : '') + '>' + safe(t('addOptionalCheckRule')) + '</button></div></td></tr>';
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
  setPanelConfigPath(qualityGateConfigPathNode, '');
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
    + metric(t('qualityGateBaselineVersion'), qualityGateRulePackLabel(tab, 'baseline_version_label', 'baseline_version'))
    + metric(t('qualityGateShippedBaselineVersion'), qualityGateRulePackLabel(tab, 'shipped_baseline_version_label', 'shipped_baseline_version'))
    + metric(t('qualityGateBaselineRules'), tab.baseline_rule_count)
    + metric(t('qualityGateCustomRules'), tab.custom_rule_count)
    + '</section>'
    + renderQualityGateToggle(settingsPayload.settings || [], disabled)
    + renderQualityGateLatestCheck(tab.latest_check)
    + '<section class="quality-gate-block"><h3>' + safe(t('qualityGateRuleSet')) + '</h3>'
    + (rules.length === 0 ? '<p class="empty">' + safe(t('qualityGateRulesEmpty')) + '</p>' : '<div class="workflow-table quality-gate-rule-table"><table><thead><tr><th>' + safe(t('idColumn')) + '</th><th>' + safe(t('qualityGateSourceColumn')) + '</th><th>' + safe(t('statusColumn')) + '</th><th>' + safe(t('titleColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('gardaSwitchState')) + '</th><th>' + safe('Excluded scopes') + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + renderQualityGateRuleRows(rules, disabled) + '</tbody></table></div>')
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
