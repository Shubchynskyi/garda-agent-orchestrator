/** Browser-side dashboard script fragment (project-memory). */
export const UI_DASHBOARD_CLIENT_PROJECT_MEMORY = `function localizedMemoryFile(file) {
  return {
    label: localizedField(projectMemoryTextPacks, file.path, 'label', file.path),
    description: localizedField(projectMemoryTextPacks, file.path, 'description', file.purpose)
  };
}
function localizedMemoryStatusRow(row) {
  return {
    label: localizedField(projectMemoryStatusTextPacks, row.id, 'label', row.label),
    description: localizedField(projectMemoryStatusTextPacks, row.id, 'description', row.description)
  };
}
function renderMemoryValueTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">' + safe(t('noInitSettings')) + '</p>';
  }
  return '<div class="value-table"><table><thead><tr><th>' + safe(t('fieldColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('valueColumn')) + '</th></tr></thead><tbody>'
    + rows.map(row => {
      const localized = localizedMemoryStatusRow(row);
      const valueOpenControl = row.file_path ? openFileButton(row.file_path, 'memory-file-content') : '';
      return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(row.id) + '</code></td><td class="description-cell">' + inlineText(localized.description) + '</td><td><span class="value-with-open"><code class="current-value">' + safe(renderJsonValue(row.value)) + '</code>' + valueOpenControl + '</span></td></tr>';
    }).join('')
    + '</tbody></table></div>';
}
function renderProjectMemorySettings() {
  const tab = currentReport && currentReport.project_memory_tab ? currentReport.project_memory_tab : {};
  const reportSettings = (tab.settings || []).map(setting => Object.assign({}, setting, {
    current_value: setting.current_value === undefined ? setting.value : setting.current_value,
    confirmation_phrase: setting.confirmation_phrase || 'APPLY GARDA SETTING'
  }));
  const actionSettings = currentSettingsPayload && currentSettingsPayload.settings
    ? currentSettingsPayload.settings.filter(setting => settingGroupId(setting) === 'memory')
    : [];
  const settings = actionSettings.length > 0 ? actionSettings : reportSettings;
  if (settings.length === 0 && !currentSettingsPayload) {
    return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3><p class="empty">' + safe(t('loading')) + '</p></section>';
  }
  if (settings.length === 0) {
    return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3><p class="empty">' + safe(t('noWorkflowSettings')) + '</p></section>';
  }
  const disabled = !currentSettingsPayload || !currentSettingsPayload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '<p class="empty">' + safe(t('guardedEditorHelp')) + '</p>';
  return '<section class="memory-section"><h3>' + safe(t('workflowGroupMemory')) + '</h3>' + disabledNotice
    + '<div id="memory-setting-status" class="setting-status">' + (currentMemorySettingResult ? renderSettingResultMarkup(currentMemorySettingResult) : '') + '</div>'
    + '<div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>'
    + settings.map(setting => renderSettingRow(setting, disabled, 'memory')).join('')
    + '</tbody></table></div></section>';
}
function renderProjectMemoryOptimizationAdvisory(tab) {
  const advisory = tab.advisory || {};
  const promptPath = advisory.prompt_path || 'garda-agent-orchestrator/template/docs/prompts/project-memory-optimization.md';
  const openControl = advisory.prompt_exists ? openFileButton(promptPath, 'memory-file-content') : '';
  return '<section class="memory-section memory-advisory"><h3>' + safe(t('projectMemoryOptimizationTitle')) + '</h3>'
    + '<p>' + inlineText(t('projectMemoryOptimizationBody')) + '</p>'
    + '<p class="memory-prompt-path"><strong>' + safe(t('projectMemoryOptimizationPromptFile')) + '</strong> <span class="value-with-open"><code>' + safe(promptPath) + '</code>' + openControl + '</span></p></section>';
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
  setPanelConfigPath(projectMemoryConfigPathNode, [
    tab.settings_config_path,
    tab.memory_directory_path
  ]);
  projectMemoryNode.innerHTML = renderProjectMemoryOptimizationAdvisory(tab)
    + renderProjectMemorySettings()
    + '<section class="memory-section"><h3>' + safe(t('projectMemoryStatusTitle')) + '</h3>' + renderMemoryValueTable(tab.status || []) + '</section>'
    + '<section class="memory-section"><h3>' + safe(t('projectMemoryFilesTitle')) + '</h3>'
    + (files.length === 0 ? '<p class="empty">' + safe(t('noProjectMemoryFiles')) + '</p>' : '<div class="memory-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('purposeColumn')) + '</th><th>' + safe(t('sizeColumn')) + '</th></tr></thead><tbody>'
      + files.map(file => {
        const localized = localizedMemoryFile(file);
        return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(file.path) + '</code>' + (file.exists ? '<div class="file-open-row">' + openFileButton(file.path, 'memory-file-content') + '</div>' : '<br><span class="empty">' + safe(t('missing')) + '</span>') + '</td><td class="description-cell">' + safe(localized.description) + '</td><td><code>' + safe(file.size_bytes === null ? '-' : file.size_bytes) + '</code></td></tr>';
      }).join('') + '</tbody></table></div>')
    + '<section id="memory-file-content" class="memory-file-content" hidden></section></section>';
  wireFileButtons(projectMemoryNode);
  wireProjectMemorySettings();
}
`;
