/** Browser-side dashboard script fragment (project-memory). */
export const UI_DASHBOARD_CLIENT_PROJECT_MEMORY = `function localizedMemoryFile(file) {
  return {
    label: localizedField(projectMemoryTextPacks, file.path, 'label', file.path),
    description: localizedField(projectMemoryTextPacks, file.path, 'description', file.purpose)
  };
}
function renderProjectMemorySettings() {
  const payload = currentSettingsPayload;
  if (!payload || !payload.settings) {
    return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3><p class="empty">' + safe(t('loading')) + '</p></section>';
  }
  const settings = payload.settings.filter(setting => settingGroupId(setting) === 'memory');
  if (settings.length === 0) {
    return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3><p class="empty">' + safe(t('noWorkflowSettings')) + '</p></section>';
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '<p class="empty">' + safe(t('guardedEditorHelp')) + '</p>';
  return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3>' + disabledNotice
    + '<div id="memory-setting-status" class="setting-status">' + (currentMemorySettingResult ? renderSettingResultMarkup(currentMemorySettingResult) : '') + '</div>'
    + '<div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>'
    + settings.map(setting => renderSettingRow(setting, disabled, 'memory')).join('')
    + '</tbody></table></div></section>';
}
function wireProjectMemorySettings() {
  const settings = currentSettingsPayload && currentSettingsPayload.settings ? currentSettingsPayload.settings : [];
  for (const button of projectMemoryNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const controlScope = button.dataset.settingControlScope || 'memory';
      const input = document.getElementById(settingControlId(button.dataset.settingId, controlScope));
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, settingSubmitValue(setting, input, controlScope), confirmation, result => {
        currentMemorySettingResult = result;
        const memoryStatusNode = document.getElementById('memory-setting-status');
        if (memoryStatusNode) {
          memoryStatusNode.innerHTML = renderSettingResultMarkup(result);
        }
      });
    });
  }
}
function renderProjectMemory(report) {
  const tab = report.project_memory_tab || {};
  const files = tab.files || [];
  projectMemoryNode.innerHTML = '<section class="memory-section"><h3>' + safe(t('projectMemoryStatusTitle')) + '</h3>' + renderValueTable(tab.status || []) + '</section>'
    + '<section class="memory-section"><h3>' + safe(t('projectMemoryFilesTitle')) + '</h3>'
    + (files.length === 0 ? '<p class="empty">' + safe(t('noProjectMemoryFiles')) + '</p>' : '<div class="memory-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('purposeColumn')) + '</th><th>' + safe(t('sizeColumn')) + '</th></tr></thead><tbody>'
      + files.map(file => {
        const localized = localizedMemoryFile(file);
        return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(file.path) + '</code>' + (file.exists ? '<div class="file-open-row">' + openFileButton(file.path, 'memory-file-content') + '</div>' : '<br><span class="empty">' + safe(t('missing')) + '</span>') + '</td><td class="description-cell">' + safe(localized.description) + '</td><td><code>' + safe(file.size_bytes === null ? '-' : file.size_bytes) + '</code></td></tr>';
      }).join('') + '</tbody></table></div>')
    + '<section id="memory-file-content" class="memory-file-content" hidden></section></section>'
    + renderProjectMemorySettings();
  wireFileButtons(projectMemoryNode);
  wireProjectMemorySettings();
}
`;
