/** Browser-side dashboard script fragment (core). */
export const UI_DASHBOARD_CLIENT_CORE = `function normalizeLanguage(value) {
  return Object.prototype.hasOwnProperty.call(languagePacks, value) ? value : fallbackLanguage;
}
function readStoredLanguage() {
  try {
    return window.localStorage ? window.localStorage.getItem('garda.ui.language') : null;
  } catch {
    return null;
  }
}
function detectBrowserLanguage() {
  const supportedIds = languageMetadata.map(language => language.id);
  const localeIds = [];
  if (typeof navigator !== 'undefined') {
    if (navigator.language) {
      localeIds.push(navigator.language);
    }
    if (Array.isArray(navigator.languages)) {
      for (const locale of navigator.languages) {
        if (locale) {
          localeIds.push(locale);
        }
      }
    }
  }
  for (const locale of localeIds) {
    const normalized = String(locale || '').trim();
    if (!normalized) {
      continue;
    }
    if (supportedIds.includes(normalized)) {
      return normalized;
    }
    const localeLower = normalized.toLowerCase();
    const exactMatch = supportedIds.find(id => id.toLowerCase() === localeLower);
    if (exactMatch) {
      return exactMatch;
    }
    const base = normalized.split('-')[0];
    if (supportedIds.includes(base)) {
      return base;
    }
    const baseLower = base.toLowerCase();
    const baseMatch = supportedIds.find(id => id.split('-')[0].toLowerCase() === baseLower);
    if (baseMatch) {
      return baseMatch;
    }
  }
  return null;
}
let currentLanguage = normalizeLanguage(readStoredLanguage() || detectBrowserLanguage() || initialLanguage);
function t(key) {
  return (languagePacks[currentLanguage] && languagePacks[currentLanguage][key]) || languagePacks[fallbackLanguage][key] || key;
}
function localizedEntry(pack, id) {
  return (pack[currentLanguage] && pack[currentLanguage][id]) || (pack[fallbackLanguage] && pack[fallbackLanguage][id]) || null;
}
function localizedField(pack, id, field, fallback) {
  const entry = localizedEntry(pack, id);
  return entry && entry[field] ? entry[field] : fallback;
}
function localizedOption(pack, id, option, field, fallback) {
  const entry = localizedEntry(pack, id);
  if (entry && entry.options && entry.options[option.value] && entry.options[option.value][field]) {
    return entry.options[option.value][field];
  }
  return fallback;
}
function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function inlineText(value) {
  const tick = String.fromCharCode(96);
  const parts = String(value ?? '').split(new RegExp('(' + tick + '[^' + tick + ']*' + tick + ')', 'gu'));
  return parts.map(part => part.length >= 2 && part.startsWith(tick) && part.endsWith(tick)
    ? '<code>' + safe(part.slice(1, -1)) + '</code>'
    : safe(part)).join('');
}
function classToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');
}
function badge(value, prefix, extraClass) {
  const text = String(value || 'unknown');
  const css = extraClass || (safe(prefix || 'status') + '-' + classToken(text));
  return '<span class="badge ' + css + '">' + safe(text) + '</span>';
}
function metric(label, value) {
  return '<div class="metric"><span>' + safe(label) + '</span><strong>' + safe(value ?? '-') + '</strong></div>';
}
function fullSuiteValue(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}
function fullSuiteSummary(fullSuite) {
  if (!fullSuite) {
    return '<p class="empty">-</p>';
  }
  const rows = [
    [t('fullSuiteCommand'), fullSuite.command],
    [t('fullSuitePlacement'), fullSuite.placement],
    [t('fullSuiteFreshness'), fullSuite.freshness],
    [t('fullSuiteTimeoutForecast'), fullSuite.timeout_forecast_label],
    [t('fullSuiteArtifact'), fullSuite.artifact_path + (fullSuite.artifact_exists ? '' : ' (' + t('missing') + ')')],
    [t('fullSuiteOutput'), fullSuite.output_artifact_path]
  ];
  const newline = String.fromCharCode(10);
  const summary = (fullSuite.compact_summary || []).length > 0
    ? '<h4>' + safe(t('fullSuiteSummary')) + '</h4><pre>' + safe(fullSuite.compact_summary.join(newline)) + '</pre>'
    : '';
  const diagnostics = [fullSuite.mismatch_reason, ...(fullSuite.violations || []), ...(fullSuite.warnings || [])]
    .filter(Boolean);
  return '<div class="detail-table"><table><tbody>'
    + rows.map(([label, value]) => '<tr><th>' + safe(label) + '</th><td>' + safe(fullSuiteValue(value)) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + summary
    + (diagnostics.length > 0 ? '<ul class="list">' + diagnostics.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>' : '');
}
function workflowStatusText(status) {
  if (status === 'present') return t('workflowStatusPresent');
  if (status === 'missing') return t('workflowStatusMissing');
  if (status === 'invalid') return t('workflowStatusInvalid');
  return String(status || 'unknown');
}
function resultStatusText(status) {
  if (status === 'previewed') return t('resultStatusPreviewed');
  if (status === 'executed') return t('resultStatusExecuted');
  if (status === 'confirmation_required') return t('resultStatusConfirmationRequired');
  if (status === 'disabled') return t('resultStatusDisabled');
  if (status === 'unavailable') return t('resultStatusUnavailable');
  return String(status || '-');
}
function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean).map(value => String(value)))).sort((a, b) => a.localeCompare(b));
}
function setOptions(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = '<option value="">' + safe(allLabel) + '</option>' + values.map(value => '<option value="' + safe(value) + '">' + safe(value) + '</option>').join('');
  select.value = values.includes(previous) ? previous : '';
}
function renderLanguageSelector() {
  languageSelectNode.innerHTML = languageMetadata.map(language => '<option value="' + safe(language.id) + '">' + safe(language.nativeLabel) + '</option>').join('');
  languageSelectNode.value = currentLanguage;
}
function applyLanguage() {
  if (document.documentElement) {
    document.documentElement.lang = currentLanguage;
  }
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.getAttribute('data-i18n'));
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
  }
  for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.getAttribute('data-i18n-aria-label')));
  }
  uiNoticeNode.textContent = actionsEnabled ? t('noticeActionsEnabled') : t('noticeActionsDisabled');
  renderLanguageSelector();
  if (currentReport) {
    renderTasks(currentReport);
  }
  if (currentSession) {
    renderSession(currentSession);
  }
  if (currentActionsPayload) {
    renderActions(currentActionsPayload);
  }
  if (currentSettingsPayload) {
    renderSettingsEditor(currentSettingsPayload);
  }
  if (currentSettingResult) {
    renderSettingResult(currentSettingResult);
  }
  if (currentActionResult) {
    renderActionResult(currentActionResult);
  }
  if (currentTaskDetail) {
    renderTaskDetail(currentTaskDetail);
  }
  if (currentReport) {
    renderBackups(currentReport);
  }
  if (currentBackupActionResult) {
    renderBackupActionResult(currentBackupActionResult);
  }
  if (typeof currentBackupSettingResult !== 'undefined' && currentBackupSettingResult) {
    renderBackupSettingResult(currentBackupSettingResult);
  }
  if (currentCleanupPayload) {
    renderCleanupSettings(currentCleanupPayload);
  }
  if (currentCleanupResult) {
    renderCleanupResult(currentCleanupResult);
  }
}
function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return '-';
  }
  const normalized = Math.max(0, Math.ceil(value));
  if (normalized < 60) {
    return normalized + 's';
  }
  return Math.ceil(normalized / 60) + 'm';
}
function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) {
    return '-';
  }
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + 'm ' + seconds + 's (' + Math.trunc(ms) + ' ms)';
}
function durationPartsFromMs(value) {
  const ms = Number(value);
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60
  };
}
function isDurationMsSetting(setting) {
  return setting && setting.value_type === 'integer' && String(setting.key || '').endsWith('_ms');
}
`;
