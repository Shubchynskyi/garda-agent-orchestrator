/** Browser-side dashboard script fragment (profiles). */
export const UI_DASHBOARD_CLIENT_PROFILES = `let currentProfileTabName = '';
function profilePolicyValue(profile, reviewType) {
  const policy = profile && profile.review_policy && Object.prototype.hasOwnProperty.call(profile.review_policy, reviewType)
    ? profile.review_policy[reviewType]
    : 'auto';
  if (policy === true || policy === 'required') return 'required';
  if (policy === false || policy === 'disabled') return 'disabled';
  return 'auto';
}
function profilePolicyFromSubmitValue(value) {
  if (value === 'required') return true;
  if (value === 'disabled') return false;
  return 'auto';
}
function profilePolicyClass(value) {
  if (value === 'required') return 'profile-policy-required';
  if (value === 'disabled') return 'profile-policy-disabled';
  return 'profile-policy-auto';
}
function profileInputId(profileName, field) {
  return 'profile-' + String(profileName || 'new').replace(/[^a-z0-9_-]/gi, '-') + '-' + field;
}
function profileReviewInputId(profileName, reviewType) {
  return profileInputId(profileName, 'review-' + reviewType);
}
function profileFindingInputId(profileName, field) {
  return profileInputId(profileName, 'finding-' + field);
}
function profileFollowUpInputId(profileName, field) {
  return profileInputId(profileName, 'follow-up-' + field);
}
function renderProfileResult(result) {
  currentProfileActionResult = result;
  if (!profilesStatusNode) return;
  profilesStatusNode.innerHTML = renderSettingResultMarkup({
    setting_id: 'profiles',
    label: result && result.profile_name ? result.profile_name : t('profilesTab'),
    key: result && result.operation ? result.operation : 'profiles',
    status: result && result.status ? result.status : 'error',
    current_value: result ? result.current_active_profile : null,
    proposed_value: result ? result.proposed_active_profile : null,
    changed_keys: result && result.changed_keys ? result.changed_keys : [],
    command: result && result.command ? result.command : '',
    audit_path: result && result.audit_path ? result.audit_path : null,
    error: result && result.error ? result.error : null
  });
}
function renderProfilePolicySelect(profileName, reviewType, value, disabled) {
  const disabledAttr = disabled ? ' disabled' : '';
  const options = [
    ['required', t('profilePolicyRequired')],
    ['auto', t('profilePolicyAuto')],
    ['disabled', t('profilePolicyDisabled')]
  ];
  return '<select id="' + safe(profileReviewInputId(profileName, reviewType)) + '"' + disabledAttr + '>'
    + options.map(([optionValue, label]) => '<option value="' + safe(optionValue) + '"' + (optionValue === value ? ' selected' : '') + '>' + safe(label) + '</option>').join('')
    + '</select>';
}
function renderProfilePolicyGrid(profile, disabled) {
  const reviewTypes = currentProfilesPayload && Array.isArray(currentProfilesPayload.review_types)
    ? currentProfilesPayload.review_types
    : [];
  if (reviewTypes.length === 0) {
    return '<p class="empty">' + safe(t('availableReviewTypes')) + ': -</p>';
  }
  return '<div class="profile-policy-grid">'
    + reviewTypes.map(reviewType => {
      const policyValue = profilePolicyValue(profile, reviewType.id);
      return '<label class="' + profilePolicyClass(policyValue) + '"><span>' + safe(reviewType.label || reviewType.id) + '</span>'
        + renderProfilePolicySelect(profile.name, reviewType.id, policyValue, disabled)
        + '</label>';
    }).join('')
    + '</div>';
}
function findingPolicyActions() {
  return currentProfilesPayload && Array.isArray(currentProfilesPayload.finding_policy_actions)
    ? currentProfilesPayload.finding_policy_actions
    : [];
}
function findingPolicyPresets() {
  return currentProfilesPayload && currentProfilesPayload.finding_policy_presets
    ? currentProfilesPayload.finding_policy_presets
    : {};
}
function findingPolicyFieldLabel(key) {
  const translationKeys = {
    critical: 'profileFindingCritical',
    high: 'profileFindingHigh',
    medium: 'profileFindingMedium',
    low: 'profileFindingLow',
    residual_risk: 'profileFindingResidualRisk'
  };
  return t(translationKeys[key] || key);
}
function findingPolicyActionLabel(action) {
  const translationKeys = {
    fix_now: 'profileFindingActionFixNow',
    create_follow_up: 'profileFindingActionCreateFollowUp',
    ignore: 'profileFindingActionIgnore'
  };
  return t(translationKeys[action] || action);
}
function findingPolicyPresetLabel(presetId) {
  const translationKeys = {
    soft: 'profileFindingPresetSoft',
    balanced: 'profileFindingPresetBalanced',
    strict: 'profileFindingPresetStrict',
    custom: 'profileFindingPresetCustom'
  };
  return t(translationKeys[presetId] || presetId);
}
function renderFindingActionSelect(profileName, key, value, disabled, locked) {
  const options = findingPolicyActions();
  const values = options.includes(value) ? options : [value, ...options];
  return '<select id="' + safe(profileFindingInputId(profileName, key)) + '" data-profile-finding-action="' + safe(key) + '"'
    + (disabled || locked ? ' disabled' : '') + ' aria-label="' + safe(findingPolicyFieldLabel(key)) + '">'
    + values.map(action => '<option value="' + safe(action) + '"' + (action === value ? ' selected' : '') + '>' + safe(findingPolicyActionLabel(action)) + '</option>').join('')
    + '</select>';
}
function renderFindingPolicySection(profile, disabled) {
  const policy = profile.review_finding_policy || {};
  const findings = policy.findings || {};
  const presets = findingPolicyPresets();
  const presetIds = [...Object.keys(presets), 'custom'];
  const profiles = currentProfilesPayload && Array.isArray(currentProfilesPayload.profiles)
    ? currentProfilesPayload.profiles
    : [];
  const copySources = profiles.filter(candidate => candidate.name !== profile.name);
  return '<fieldset class="profile-finding-policy"><legend>' + safe(t('profileFindingDispositionTitle')) + '</legend>'
    + '<p class="empty profile-finding-policy-help">' + safe(t('profileFindingDispositionHelp')) + ' ' + safe(t('profileFindingActionIgnoreHelp')) + '</p>'
    + '<div class="profile-finding-policy-toolbar">'
    + '<label><span>' + safe(t('profileFindingPolicyPreset')) + '</span><select id="' + safe(profileFindingInputId(profile.name, 'preset')) + '"' + (disabled ? ' disabled' : '') + '>'
    + presetIds.map(presetId => '<option value="' + safe(presetId) + '"' + (presetId === policy.policy_id ? ' selected' : '') + '>' + safe(findingPolicyPresetLabel(presetId)) + '</option>').join('')
    + '</select></label>'
    + '<label><span>' + safe(t('profileCopyFrom')) + '</span><select id="' + safe(profileFindingInputId(profile.name, 'copy-from')) + '"' + (disabled || copySources.length === 0 ? ' disabled' : '') + '>'
    + copySources.map(candidate => '<option value="' + safe(candidate.name) + '">' + safe(candidate.name) + '</option>').join('')
    + '</select></label>'
    + '<button type="button" data-profile-policy-action="copy" data-profile-name="' + safe(profile.name) + '"' + (disabled || copySources.length === 0 ? ' disabled' : '') + '>' + safe(t('profileFindingCopyPolicy')) + '</button>'
    + '<button type="button" data-profile-policy-action="reset" data-profile-name="' + safe(profile.name) + '"' + (disabled ? ' disabled' : '') + '>' + safe(t('profileFindingResetPolicy')) + '</button>'
    + '</div>'
    + '<div class="profile-finding-policy-grid">'
    + '<label class="profile-finding-critical"><span>' + safe(findingPolicyFieldLabel('critical')) + '</span>' + renderFindingActionSelect(profile.name, 'critical', findings.critical || 'fix_now', disabled, true) + '</label>'
    + '<label><span>' + safe(findingPolicyFieldLabel('high')) + '</span>' + renderFindingActionSelect(profile.name, 'high', findings.high || '', disabled, false) + '</label>'
    + '<label><span>' + safe(findingPolicyFieldLabel('medium')) + '</span>' + renderFindingActionSelect(profile.name, 'medium', findings.medium || '', disabled, false) + '</label>'
    + '<label><span>' + safe(findingPolicyFieldLabel('low')) + '</span>' + renderFindingActionSelect(profile.name, 'low', findings.low || '', disabled, false) + '</label>'
    + '<label><span>' + safe(findingPolicyFieldLabel('residual_risk')) + '</span>' + renderFindingActionSelect(profile.name, 'residual_risk', policy.residual_risk || '', disabled, false) + '</label>'
    + '</div>'
    + '<div class="profile-card-footer"><button type="button" data-profile-policy-action="apply" data-profile-name="' + safe(profile.name) + '"' + (disabled ? ' disabled' : '') + '>' + safe(t('apply')) + '</button></div>'
    + '</fieldset>';
}
function followUpTaskProfileModeLabel(mode) {
  const translationKeys = {
    one_level_lighter: 'profileFollowUpTaskProfileOneLevelLighter',
    inherit_parent: 'profileFollowUpTaskProfileInheritParent',
    fixed_profile: 'profileFollowUpTaskProfileFixed'
  };
  return t(translationKeys[mode] || mode);
}
function followUpTaskProfileSourceLabel(source) {
  if (source === 'safe_inherit_parent') return followUpTaskProfileModeLabel('inherit_parent');
  return followUpTaskProfileModeLabel(source);
}
function renderFollowUpTaskProfileSection(profile, disabled) {
  const policy = profile.review_follow_up_policy || {};
  const taskProfile = policy.task_profile || { mode: 'one_level_lighter', fixed_profile: null };
  const mode = taskProfile.mode || 'one_level_lighter';
  const profiles = currentProfilesPayload && Array.isArray(currentProfilesPayload.profiles)
    ? currentProfilesPayload.profiles
    : [];
  const fixedProfile = taskProfile.fixed_profile || profile.name;
  const assignment = profile.review_follow_up_task_profile_assignment || {};
  const effectiveProfile = assignment.profile || profile.name;
  const assignmentSource = assignment.source || mode;
  const disabledAttr = disabled ? ' disabled' : '';
  const fixedDisabledAttr = disabled || mode !== 'fixed_profile' ? ' disabled' : '';
  return '<fieldset class="profile-follow-up-task-profile"><legend>' + safe(t('profileFollowUpTaskProfileTitle')) + '</legend>'
    + '<p class="empty profile-follow-up-task-profile-help">' + safe(t('profileFollowUpTaskProfileHelp')) + '</p>'
    + '<div class="profile-fields">'
    + '<label><span>' + safe(t('profileFollowUpTaskProfileMode')) + '</span><select id="' + safe(profileFollowUpInputId(profile.name, 'mode')) + '"' + disabledAttr + '>'
    + ['one_level_lighter', 'inherit_parent', 'fixed_profile'].map(option => '<option value="' + safe(option) + '"' + (option === mode ? ' selected' : '') + '>' + safe(followUpTaskProfileModeLabel(option)) + '</option>').join('')
    + '</select></label>'
    + '<label><span>' + safe(t('profileFollowUpTaskProfileFixedProfile')) + '</span><select id="' + safe(profileFollowUpInputId(profile.name, 'fixed-profile')) + '"' + fixedDisabledAttr + '>'
    + profiles.map(candidate => '<option value="' + safe(candidate.name) + '"' + (candidate.name === fixedProfile ? ' selected' : '') + '>' + safe(candidate.name) + '</option>').join('')
    + '</select></label>'
    + '</div>'
    + '<p class="empty profile-follow-up-task-profile-effective"><strong>' + safe(t('currentValueColumn')) + ':</strong> <code>' + safe(effectiveProfile) + '</code> (' + safe(followUpTaskProfileSourceLabel(assignmentSource)) + ')</p>'
    + '</fieldset>';
}
function renderAddProfileForm(payload, disabled) {
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const activeProfile = payload.active_profile || (profiles[0] && profiles[0].name) || '';
  const disabledAttr = disabled ? ' disabled' : '';
  return '<section class="profile-add-row">'
    + '<label><span>' + safe(t('profileName')) + '</span><input id="profile-new-name" type="text" placeholder="custom-profile"' + disabledAttr + '></label>'
    + '<label><span>' + safe(t('profileCopyFrom')) + '</span><select id="profile-new-copy-from"' + disabledAttr + '>'
    + profiles.map(profile => '<option value="' + safe(profile.name) + '"' + (profile.name === activeProfile ? ' selected' : '') + '>' + safe(profile.name) + '</option>').join('')
    + '</select></label>'
    + '<label><span>' + safe(t('descriptionColumn')) + '</span><input id="profile-new-description" type="text"' + disabledAttr + '></label>'
    + '<label><span>' + safe(t('profileDepth')) + '</span><select id="profile-new-depth"' + disabledAttr + '><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select></label>'
    + '<button type="button" data-profile-action="create"' + (disabled ? ' disabled' : '') + '>' + safe(t('addProfile')) + '</button>'
    + '</section>';
}
function orderedProfiles(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return [
    ...list.filter(profile => profile.source === 'user'),
    ...list.filter(profile => profile.source === 'built_in')
  ];
}
function resolveProfileTabName(payload, profiles) {
  const ordered = orderedProfiles(profiles);
  if (ordered.some(profile => profile.name === currentProfileTabName)) {
    return currentProfileTabName;
  }
  const activeProfile = payload && payload.active_profile ? payload.active_profile : '';
  if (ordered.some(profile => profile.name === activeProfile)) {
    currentProfileTabName = activeProfile;
    return currentProfileTabName;
  }
  currentProfileTabName = ordered.length > 0 ? ordered[0].name : '';
  return currentProfileTabName;
}
function renderProfileTabButton(profile, selected) {
  const sourceLabel = profile.source === 'built_in' ? t('profileSourceBuiltIn') : t('profileSourceUser');
  const badges = '<span class="profile-tab-badges">'
    + badge(sourceLabel, 'profile-source', profile.source === 'built_in' ? 'profile-source-built-in' : 'profile-source-user')
    + (profile.active ? badge(t('active'), 'profile-active', 'profile-active') : '')
    + '</span>';
  return '<button type="button" class="profile-tab-button' + (selected ? ' active' : '') + '" role="tab" aria-selected="' + (selected ? 'true' : 'false') + '" data-profile-tab="' + safe(profile.name) + '">'
    + '<span class="profile-tab-name">' + safe(profile.name) + '</span>'
    + badges
    + '</button>';
}
function renderProfileTabGroup(title, profiles, selectedName, emptyText) {
  return '<section class="profile-tab-group"><h3>' + safe(title) + '</h3>'
    + (profiles.length > 0
      ? '<div class="profile-tab-list" role="tablist" aria-label="' + safe(title) + '">'
        + profiles.map(profile => renderProfileTabButton(profile, profile.name === selectedName)).join('')
        + '</div>'
      : '<p class="empty">' + safe(emptyText) + '</p>')
    + '</section>';
}
function renderProfileTabs(profiles, selectedName) {
  const list = Array.isArray(profiles) ? profiles : [];
  const userProfiles = list.filter(profile => profile.source === 'user');
  const builtInProfiles = list.filter(profile => profile.source === 'built_in');
  return '<section class="profile-tab-groups">'
    + renderProfileTabGroup(t('profileUserProfiles'), userProfiles, selectedName, t('profileNoUserProfiles'))
    + renderProfileTabGroup(t('profileBuiltInProfiles'), builtInProfiles, selectedName, t('profileNoBuiltInProfiles'))
    + '</section>';
}
function renderProfileCard(profile, disabled) {
  const disabledAttr = disabled ? ' disabled' : '';
  const deleteDisabledAttr = disabled || profile.protected ? ' disabled' : '';
  const resetDisabledAttr = disabled || !profile.protected ? ' disabled' : '';
  const sourceLabel = profile.source === 'built_in' ? t('profileSourceBuiltIn') : t('profileSourceUser');
  return '<article class="profile-card" data-profile-name="' + safe(profile.name) + '">'
    + '<div class="profile-card-head"><div><h3>' + safe(profile.name) + '</h3><div class="profile-card-meta">'
    + badge(sourceLabel, 'profile-source', profile.source === 'built_in' ? 'profile-source-built-in' : 'profile-source-user')
    + (profile.active ? badge(t('active'), 'profile-active', 'profile-active') : '')
    + '</div></div><div class="profile-card-actions">'
    + '<button type="button" data-profile-action="select" data-profile-name="' + safe(profile.name) + '"' + (disabled || profile.active ? ' disabled' : '') + '>' + safe(t('profileSetActive')) + '</button>'
    + '<button type="button" data-profile-action="reset" data-profile-name="' + safe(profile.name) + '"' + resetDisabledAttr + '>' + safe(t('profileReset')) + '</button>'
    + '<button type="button" data-profile-action="delete" data-profile-name="' + safe(profile.name) + '"' + deleteDisabledAttr + '>' + safe(t('profileDelete')) + '</button>'
    + '</div></div>'
    + '<div class="profile-fields">'
    + '<label><span>' + safe(t('descriptionColumn')) + '</span><input id="' + safe(profileInputId(profile.name, 'description')) + '" type="text" value="' + safe(profile.description) + '"' + disabledAttr + '></label>'
    + '<label><span>' + safe(t('profileDepth')) + '</span><select id="' + safe(profileInputId(profile.name, 'depth')) + '"' + disabledAttr + '>'
    + [1, 2, 3].map(depth => '<option value="' + depth + '"' + (Number(profile.depth) === depth ? ' selected' : '') + '>' + depth + '</option>').join('')
    + '</select></label>'
    + '</div>'
    + renderFindingPolicySection(profile, disabled)
    + renderFollowUpTaskProfileSection(profile, disabled)
    + renderProfilePolicyGrid(profile, disabled)
    + '<div class="profile-card-footer"><button type="button" data-profile-action="save" data-profile-name="' + safe(profile.name) + '"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div>'
    + '</article>';
}
function readFindingPolicyForm(profileName) {
  const preset = document.getElementById(profileFindingInputId(profileName, 'preset'));
  const presetValue = preset ? preset.value : 'custom';
  const payload = {
    operation: 'policy',
    profile_name: profileName,
    policy_preset: presetValue
  };
  if (presetValue === 'custom') {
    const actions = {};
    for (const key of ['critical', 'high', 'medium', 'low', 'residual_risk']) {
      const input = document.getElementById(profileFindingInputId(profileName, key));
      actions[key] = input ? input.value : '';
    }
    payload.policy_actions = actions;
  }
  return payload;
}
function readProfileForm(profileName) {
  const description = document.getElementById(profileInputId(profileName, 'description'));
  const depth = document.getElementById(profileInputId(profileName, 'depth'));
  const reviewTypes = currentProfilesPayload && Array.isArray(currentProfilesPayload.review_types)
    ? currentProfilesPayload.review_types
    : [];
  const reviewPolicy = {};
  for (const reviewType of reviewTypes) {
    const input = document.getElementById(profileReviewInputId(profileName, reviewType.id));
    reviewPolicy[reviewType.id] = profilePolicyFromSubmitValue(input ? input.value : 'auto');
  }
  const followUpModeInput = document.getElementById(profileFollowUpInputId(profileName, 'mode'));
  const fixedProfileInput = document.getElementById(profileFollowUpInputId(profileName, 'fixed-profile'));
  const followUpMode = followUpModeInput ? followUpModeInput.value : 'one_level_lighter';
  const currentProfile = currentProfilesPayload && Array.isArray(currentProfilesPayload.profiles)
    ? currentProfilesPayload.profiles.find(profile => profile.name === profileName)
    : null;
  const materializationMode = currentProfile && currentProfile.review_follow_up_policy
    ? currentProfile.review_follow_up_policy.materialization_mode
    : 'per_finding';
  return {
    profile_name: profileName,
    description: description ? description.value : '',
    depth: depth ? depth.value : '2',
    review_policy: reviewPolicy,
    review_follow_up_policy: {
      schema_version: 1,
      materialization_mode: materializationMode,
      task_profile: {
        mode: followUpMode,
        fixed_profile: followUpMode === 'fixed_profile' && fixedProfileInput ? fixedProfileInput.value : null
      }
    }
  };
}
async function submitProfileAction(payload) {
  const previewResponse = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ ...payload, mode: 'preview' })
  });
  const preview = await previewResponse.json();
  renderProfileResult(preview);
  if (!preview || preview.status !== 'previewed' || !/^[a-f0-9]{64}$/u.test(String(preview.preview_sha256 || ''))) {
    return;
  }
  const confirmation = profileConfirmationPrompt();
  if (confirmation === null) return;
  const executeResponse = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({
      ...payload,
      mode: 'execute',
      confirmation,
      preview_sha256: preview.preview_sha256
    })
  });
  const result = await executeResponse.json();
  renderProfileResult(result);
  if (result && result.status === 'executed') {
    if (payload && payload.operation === 'delete') {
      if (currentProfileTabName === result.profile_name) {
        currentProfileTabName = '';
      }
    } else if (result.profile_name) {
      currentProfileTabName = result.profile_name;
    }
    await refreshProfilesPayload();
  }
}
function profileConfirmationPrompt() {
  return window.prompt(t('typeToApplySetting') + ' "APPLY PROFILE CHANGE" ' + t('typeToApplySettingTail'));
}
function attachProfileActionHandlers() {
  for (const button of profilesNode.querySelectorAll('button[data-profile-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.profileAction;
      let payload = { operation: action };
      if (action === 'create') {
        const nameInput = document.getElementById('profile-new-name');
        const copyInput = document.getElementById('profile-new-copy-from');
        const descriptionInput = document.getElementById('profile-new-description');
        const depthInput = document.getElementById('profile-new-depth');
        payload = {
          operation: 'create',
          profile_name: nameInput ? nameInput.value : '',
          copy_from: copyInput ? copyInput.value : '',
          description: descriptionInput ? descriptionInput.value : '',
          depth: depthInput ? depthInput.value : '2'
        };
      } else if (action === 'save') {
        payload = { operation: 'save', ...readProfileForm(button.dataset.profileName || '') };
      } else {
        payload = { operation: action, profile_name: button.dataset.profileName || '' };
      }
      submitProfileAction(payload);
    });
  }
}
function attachProfileTabHandlers() {
  for (const button of profilesNode.querySelectorAll('button[data-profile-tab]')) {
    button.addEventListener('click', () => {
      currentProfileTabName = button.dataset.profileTab || '';
      if (currentProfilesPayload) {
        renderProfiles(currentProfilesPayload);
      }
    });
  }
}
function attachProfilePolicyVisualHandlers() {
  for (const select of profilesNode.querySelectorAll('.profile-policy-grid select')) {
    select.addEventListener('change', () => {
      const label = select.closest('label');
      if (!label) return;
      label.classList.remove('profile-policy-required', 'profile-policy-auto', 'profile-policy-disabled');
      label.classList.add(profilePolicyClass(select.value));
    });
  }
}
function attachProfileFollowUpTaskProfileHandlers() {
  const modeSelect = profilesNode.querySelector('.profile-follow-up-task-profile select[id$="-follow-up-mode"]');
  if (!modeSelect) return;
  modeSelect.addEventListener('change', () => {
    const card = modeSelect.closest('[data-profile-name]');
    const profileName = card ? card.dataset.profileName || '' : '';
    const fixedSelect = document.getElementById(profileFollowUpInputId(profileName, 'fixed-profile'));
    if (fixedSelect) fixedSelect.disabled = modeSelect.value !== 'fixed_profile';
  });
}
function setFindingPolicyInputs(profileName, policy) {
  const findings = policy && policy.findings ? policy.findings : {};
  const values = {
    critical: findings.critical,
    high: findings.high,
    medium: findings.medium,
    low: findings.low,
    residual_risk: policy ? policy.residual_risk : ''
  };
  for (const [key, value] of Object.entries(values)) {
    const input = document.getElementById(profileFindingInputId(profileName, key));
    if (input && value) input.value = value;
  }
}
function attachProfileFindingPolicyHandlers() {
  const preset = profilesNode.querySelectorAll('.profile-finding-policy select[id$="-finding-preset"]')[0];
  if (preset) {
    preset.addEventListener('change', () => {
      const card = preset.closest('[data-profile-name]');
      const profileName = card ? card.dataset.profileName || '' : '';
      const policy = findingPolicyPresets()[preset.value];
      if (policy) setFindingPolicyInputs(profileName, policy);
    });
  }
  for (const select of profilesNode.querySelectorAll('.profile-finding-policy select[data-profile-finding-action]')) {
    if (select.dataset.profileFindingAction === 'critical') continue;
    select.addEventListener('change', () => {
      const card = select.closest('[data-profile-name]');
      const profileName = card ? card.dataset.profileName || '' : '';
      const presetInput = document.getElementById(profileFindingInputId(profileName, 'preset'));
      if (presetInput) presetInput.value = 'custom';
    });
  }
  for (const button of profilesNode.querySelectorAll('button[data-profile-policy-action]')) {
    button.addEventListener('click', () => {
      const profileName = button.dataset.profileName || '';
      const action = button.dataset.profilePolicyAction;
      if (action === 'copy') {
        const copyInput = document.getElementById(profileFindingInputId(profileName, 'copy-from'));
        submitProfileAction({
          operation: 'policy',
          profile_name: profileName,
          policy_copy_from: copyInput ? copyInput.value : ''
        });
        return;
      }
      if (action === 'reset') {
        submitProfileAction({ operation: 'policy', profile_name: profileName, policy_reset: true });
        return;
      }
      submitProfileAction(readFindingPolicyForm(profileName));
    });
  }
}
function renderProfiles(payload) {
  currentProfilesPayload = payload;
  setPanelConfigPath(profilesConfigPathNode, payload && payload.config_path ? payload.config_path : '');
  const unavailable = payload && payload.unavailable ? payload.unavailable : [];
  if (unavailable.length > 0) {
    profilesNode.innerHTML = '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>';
    return;
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('profileEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '';
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const selectedName = resolveProfileTabName(payload, profiles);
  const selectedProfile = profiles.find(profile => profile.name === selectedName) || null;
  profilesNode.innerHTML = disabledNotice
    + renderAddProfileForm(payload, disabled)
    + renderProfileTabs(profiles, selectedName)
    + '<section class="profile-selected-panel" role="tabpanel">'
    + (selectedProfile ? renderProfileCard(selectedProfile, disabled) : '<p class="empty">' + safe(t('profileNoBuiltInProfiles')) + '</p>')
    + '</section>';
  attachProfileTabHandlers();
  attachProfilePolicyVisualHandlers();
  attachProfileFollowUpTaskProfileHandlers();
  attachProfileFindingPolicyHandlers();
  attachProfileActionHandlers();
}
async function refreshProfilesPayload() {
  const response = await fetch('/api/profiles');
  renderProfiles(await response.json());
}
`;
