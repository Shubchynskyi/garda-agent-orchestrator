/** Browser-side dashboard script fragment (profiles). */
export const UI_DASHBOARD_CLIENT_PROFILES = `function profilePolicyValue(profile, reviewType) {
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
function profileInputId(profileName, field) {
  return 'profile-' + String(profileName || 'new').replace(/[^a-z0-9_-]/gi, '-') + '-' + field;
}
function profileReviewInputId(profileName, reviewType) {
  return profileInputId(profileName, 'review-' + reviewType);
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
    + reviewTypes.map(reviewType => '<label><span>' + safe(reviewType.label || reviewType.id) + '</span>'
      + renderProfilePolicySelect(profile.name, reviewType.id, profilePolicyValue(profile, reviewType.id), disabled)
      + '</label>').join('')
    + '</div>';
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
    + renderProfilePolicyGrid(profile, disabled)
    + '<div class="profile-card-footer"><button type="button" data-profile-action="save" data-profile-name="' + safe(profile.name) + '"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div>'
    + '</article>';
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
  return {
    profile_name: profileName,
    description: description ? description.value : '',
    depth: depth ? depth.value : '2',
    review_policy: reviewPolicy
  };
}
async function submitProfileAction(payload, confirmation) {
  const response = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ ...payload, mode: 'execute', confirmation })
  });
  const result = await response.json();
  renderProfileResult(result);
  if (result && result.status === 'executed') {
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
      const confirmation = profileConfirmationPrompt();
      if (confirmation === null) return;
      submitProfileAction(payload, confirmation);
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
  const userProfiles = profiles.filter(profile => profile.source === 'user');
  const builtInProfiles = profiles.filter(profile => profile.source === 'built_in');
  profilesNode.innerHTML = disabledNotice
    + renderAddProfileForm(payload, disabled)
    + '<section class="profile-section"><h3>' + safe(t('profileUserProfiles')) + '</h3>'
    + (userProfiles.length > 0 ? userProfiles.map(profile => renderProfileCard(profile, disabled)).join('') : '<p class="empty">' + safe(t('profileNoUserProfiles')) + '</p>')
    + '</section>'
    + '<section class="profile-section"><h3>' + safe(t('profileBuiltInProfiles')) + '</h3>'
    + (builtInProfiles.length > 0 ? builtInProfiles.map(profile => renderProfileCard(profile, disabled)).join('') : '<p class="empty">' + safe(t('profileNoBuiltInProfiles')) + '</p>')
    + '</section>';
  attachProfileActionHandlers();
}
async function refreshProfilesPayload() {
  const response = await fetch('/api/profiles');
  renderProfiles(await response.json());
}
`;
