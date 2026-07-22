/**
 * Popup controller — manages UI state, communicates with background/content scripts.
 */

const STORAGE_KEYS = {
  LEADS: 'leads',
  WEBHOOK_URL: 'webhookUrl',
  EXTRACTION_STATE: 'extractionState',
};

/** DOM references */
const els = {
  statusDot: document.getElementById('statusDot'),
  pageStatusText: document.getElementById('pageStatusText'),
  totalLeads: document.getElementById('totalLeads'),
  sessionLeads: document.getElementById('sessionLeads'),
  progressSection: document.getElementById('progressSection'),
  progressLabel: document.getElementById('progressLabel'),
  progressPercent: document.getElementById('progressPercent'),
  progressFill: document.getElementById('progressFill'),
  progressDetail: document.getElementById('progressDetail'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  exportBtn: document.getElementById('exportBtn'),
  webhookBtn: document.getElementById('webhookBtn'),
  clearBtn: document.getElementById('clearBtn'),
  settingsToggle: document.getElementById('settingsToggle'),
  settingsPanel: document.getElementById('settingsPanel'),
  webhookUrl: document.getElementById('webhookUrl'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  notification: document.getElementById('notification'),
};

let currentTabId = null;
let isMapsSearchPage = false;
let isExtracting = false;

/**
 * Initialize popup: load storage, check active tab, bind events.
 */
async function init() {
  await loadStoredData();
  await checkActiveTab();
  bindEvents();
  listenForUpdates();
}

/**
 * Load leads count and webhook URL from Chrome storage.
 */
async function loadStoredData() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.LEADS,
    STORAGE_KEYS.WEBHOOK_URL,
    STORAGE_KEYS.EXTRACTION_STATE,
  ]);

  const leads = data[STORAGE_KEYS.LEADS] || [];
  els.totalLeads.textContent = leads.length;
  els.exportBtn.disabled = leads.length === 0;
  els.webhookBtn.disabled = leads.length === 0;

  if (data[STORAGE_KEYS.WEBHOOK_URL]) {
    els.webhookUrl.value = data[STORAGE_KEYS.WEBHOOK_URL];
  }

  const state = data[STORAGE_KEYS.EXTRACTION_STATE];
  if (state?.isRunning) {
    setExtractingUI(true);
    updateProgress(state);
  }
}

/**
 * Verify the active tab is a map business search results page.
 */
async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setPageStatus('error', 'No active tab found.');
      return;
    }

    currentTabId = tab.id;
    const url = tab.url || '';

    if (!isGoogleMapsUrl(url)) {
      setPageStatus('error', 'Open map business search results first.');
      els.startBtn.disabled = true;
      return;
    }

    const response = await sendTabMessage(currentTabId, { action: 'CHECK_PAGE' });

    if (response?.isSearchPage) {
      isMapsSearchPage = true;
      setPageStatus('ready', 'Map business search page detected.');
      if (!isExtracting) els.startBtn.disabled = false;
    } else {
      setPageStatus('error', response?.message || 'No search results found on this page.');
      els.startBtn.disabled = true;
    }
  } catch (err) {
    setPageStatus('error', 'Could not connect to map business search tab. Refresh the page and try again.');
    console.error('[Popup] checkActiveTab:', err);
  }
}

/**
 * Returns true if URL belongs to Google Maps.
 */
function isGoogleMapsUrl(url) {
  return /^https:\/\/(www\.)?google\.(com|[a-z]{2,3})\/maps/.test(url) ||
    /^https:\/\/maps\.google\./.test(url);
}

/**
 * Send a message to the content script in the given tab.
 */
function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Update the page status indicator in the popup header area.
 */
function setPageStatus(type, text) {
  els.statusDot.className = `status-dot ${type}`;
  els.pageStatusText.textContent = text;
}

/**
 * Toggle extraction-related UI elements.
 */
function setExtractingUI(running) {
  isExtracting = running;
  els.startBtn.disabled = running || !isMapsSearchPage;
  els.stopBtn.disabled = !running;
  els.exportBtn.disabled = running;
  els.webhookBtn.disabled = running;

  if (running) {
    els.statusDot.className = 'status-dot running';
    els.progressSection.hidden = false;
  } else {
    els.progressSection.hidden = true;
    if (isMapsSearchPage) {
      setPageStatus('ready', 'Map business search page detected.');
      els.startBtn.disabled = false;
    }
  }
}

/**
 * Update progress bar and detail text from extraction state.
 */
function updateProgress(state) {
  if (!state) return;

  const percent = state.total > 0
    ? Math.min(100, Math.round((state.processed / state.total) * 100))
    : state.phase === 'scrolling' ? 10 : 0;

  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
  els.progressLabel.textContent = state.isRunning ? 'Extracting…' : 'Complete';
  els.progressDetail.textContent = state.detail || '';
  els.sessionLeads.textContent = state.sessionCount ?? 0;
}

/**
 * Show a temporary notification banner in the popup.
 */
function showNotification(message, type = 'info') {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
  els.notification.hidden = false;

  clearTimeout(showNotification._timer);
  showNotification._timer = setTimeout(() => {
    els.notification.hidden = true;
  }, 5000);
}

/**
 * Bind all button and settings event listeners.
 */
function bindEvents() {
  els.startBtn.addEventListener('click', startExtraction);
  els.stopBtn.addEventListener('click', stopExtraction);
  els.exportBtn.addEventListener('click', exportExcel);
  els.webhookBtn.addEventListener('click', sendToWebhook);
  els.clearBtn.addEventListener('click', clearAllLeads);
  els.saveSettingsBtn.addEventListener('click', saveSettings);

  els.settingsToggle.addEventListener('click', () => {
    const expanded = els.settingsToggle.getAttribute('aria-expanded') === 'true';
    els.settingsToggle.setAttribute('aria-expanded', String(!expanded));
    els.settingsPanel.hidden = expanded;
  });
}

/**
 * Start the extraction process on the active Maps tab.
 */
async function startExtraction() {
  if (!currentTabId || isExtracting) return;

  // Prevent the old-leads-pileup problem: if there are already stored
  // leads from a previous session, ask before adding more on top of them
  // (which is what was causing the same businesses/files to reappear
  // across exports).
  const existing = await chrome.storage.local.get([STORAGE_KEYS.LEADS]);
  const storedLeads = existing[STORAGE_KEYS.LEADS] || [];

  if (storedLeads.length > 0) {
    const shouldClear = window.confirm(
      `You have ${storedLeads.length} unexported leads already stored. ` +
        `Press OK to clear them and start fresh, or Cancel to add new leads on top of them.`
    );

    if (shouldClear) {
      const cleared = await chrome.runtime.sendMessage({ action: 'CLEAR_LEADS' });
      if (cleared?.success) {
        els.totalLeads.textContent = '0';
        els.exportBtn.disabled = true;
        els.webhookBtn.disabled = true;
      }
    }
  }

  setExtractingUI(true);
  updateProgress({
    isRunning: true,
    processed: 0,
    total: 0,
    sessionCount: 0,
    detail: 'Starting extraction…',
    phase: 'init',
  });

  const response = await sendTabMessage(currentTabId, { action: 'START_EXTRACTION' });

  if (response?.error) {
    setExtractingUI(false);
    showNotification(response.error, 'error');
  }
}

/**
 * Signal the content script to stop extraction.
 */
async function stopExtraction() {
  if (!currentTabId) return;

  await sendTabMessage(currentTabId, { action: 'STOP_EXTRACTION' });
  await chrome.runtime.sendMessage({ action: 'STOP_EXTRACTION' });
  setExtractingUI(false);
  showNotification('Extraction stopped.', 'info');
}

/**
 * Export stored leads as an Excel (.xlsx) file download.
 */
async function exportExcel() {
  const response = await chrome.runtime.sendMessage({ action: 'EXPORT_EXCEL' });

  if (response?.success) {
    const fileWord = response.files === 1 ? 'file' : 'files';
    showNotification(
      `Exported ${response.count} leads into ${response.files} ${fileWord}.`,
      'success'
    );
  } else {
    showNotification(response?.error || 'Export failed.', 'error');
  }
}

/**
 * Wipe all stored leads, after confirming with the user — this is
 * destructive, so a confirmation prevents accidental data loss. Useful
 * for starting a fresh topic without old leads getting bundled into
 * future exports.
 */
async function clearAllLeads() {
  const confirmed = window.confirm(
    'Clear all stored leads? This cannot be undone. Export first if you still need this data.'
  );
  if (!confirmed) return;

  const response = await chrome.runtime.sendMessage({ action: 'CLEAR_LEADS' });

  if (response?.success) {
    els.totalLeads.textContent = '0';
    els.sessionLeads.textContent = '0';
    els.exportBtn.disabled = true;
    els.webhookBtn.disabled = true;
    showNotification('All leads cleared.', 'success');
  } else {
    showNotification(response?.error || 'Failed to clear leads.', 'error');
  }
}

/**
 * Send all leads to the configured n8n webhook.
 */
async function sendToWebhook() {
  els.webhookBtn.disabled = true;
  showNotification('Sending leads to webhook…', 'info');

  const response = await chrome.runtime.sendMessage({ action: 'SEND_WEBHOOK' });

  if (response?.success) {
    showNotification(`Successfully sent ${response.count} leads to webhook.`, 'success');
  } else {
    showNotification(response?.error || 'Webhook delivery failed.', 'error');
  }

  els.webhookBtn.disabled = false;
}

/**
 * Save webhook URL to Chrome storage.
 */
async function saveSettings() {
  const url = els.webhookUrl.value.trim();

  if (url && !/^https?:\/\/.+/i.test(url)) {
    showNotification('Please enter a valid HTTP or HTTPS URL.', 'error');
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.WEBHOOK_URL]: url });
  showNotification('Settings saved.', 'success');
}

/**
 * Listen for progress/completion messages from background script.
 */
function listenForUpdates() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'EXTRACTION_PROGRESS') {
      setExtractingUI(true);
      updateProgress(message.state);
    }

    if (message.action === 'EXTRACTION_COMPLETE') {
      setExtractingUI(false);
      updateProgress(message.state);
      els.totalLeads.textContent = message.totalLeads ?? 0;
      els.exportBtn.disabled = (message.totalLeads ?? 0) === 0;
      els.webhookBtn.disabled = (message.totalLeads ?? 0) === 0;

      if (message.error) {
        showNotification(message.error, 'error');
      } else {
        showNotification(`Extraction complete! ${message.newLeads ?? 0} new leads added.`, 'success');
      }
    }

    if (message.action === 'EXTRACTION_ERROR') {
      setExtractingUI(false);
      showNotification(message.error || 'Extraction failed.', 'error');
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.LEADS]) {
      const leads = changes[STORAGE_KEYS.LEADS].newValue || [];
      els.totalLeads.textContent = leads.length;
      els.exportBtn.disabled = leads.length === 0 || isExtracting;
      els.webhookBtn.disabled = leads.length === 0 || isExtracting;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
