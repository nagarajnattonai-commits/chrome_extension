/**
 * Background service worker — storage, Excel export, webhook delivery, notifications.
 */

importScripts('lib/xlsx.mini.min.js');

const STORAGE_KEYS = {
  LEADS: 'leads',
  WEBHOOK_URL: 'webhookUrl',
  EXTRACTION_STATE: 'extractionState',
};

const EXCEL_HEADERS = [
  'Business Name',
  'Category',
  'Rating',
  'Review Count',
  'Address',
  'Phone Number',
  'Website',
  'Email',
  'Social Media',
  'Search Query',
  'Map URL',
];

/** Track whether extraction should continue (global stop flag). */
let stopRequested = false;

/**
 * Handle messages from popup and content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

async function handleMessage(message, sender) {
  switch (message.action) {
    case 'STOP_EXTRACTION':
      stopRequested = true;
      return { success: true };

    case 'RESET_STOP':
      stopRequested = false;
      return { success: true };

    case 'SAVE_LEADS':
      return saveLeads(message.leads, message.state);

    case 'EXTRACTION_PROGRESS':
      await updateExtractionState(message.state);
      broadcastToPopup(message);
      return { success: true };

    case 'EXTRACTION_DONE':
      stopRequested = false;
      return finalizeExtraction(message);

    case 'ENRICH_LEAD':
      return enrichLead(message.website);

    case 'EXPORT_EXCEL':
      return exportExcel();

    case 'CLEAR_LEADS':
      return clearAllLeads();

    case 'SEND_WEBHOOK':
      return sendToWebhook();

    case 'SHOULD_STOP':
      return { stop: stopRequested };

    default:
      return { error: 'Unknown action' };
  }
}

/**
 * Merge new leads with stored leads, removing duplicates by maps URL.
 */
async function saveLeads(newLeads, state) {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.LEADS);
    const existing = data[STORAGE_KEYS.LEADS] || [];
    const merged = deduplicateLeads([...existing, ...newLeads]);

    await chrome.storage.local.set({
      [STORAGE_KEYS.LEADS]: merged,
      [STORAGE_KEYS.EXTRACTION_STATE]: state,
    });

    return { success: true, total: merged.length };
  } catch (err) {
    console.error('[Background] saveLeads:', err);
    return { error: err.message };
  }
}

/**
 * Remove duplicate leads using maps_url as primary key, name+address as fallback.
 */
function deduplicateLeads(leads) {
  const seen = new Map();

  for (const lead of leads) {
    const key = (lead.maps_url || '').trim() ||
      `${(lead.business_name || '').toLowerCase()}|${(lead.address || '').toLowerCase()}`;

    if (!key || key === '|') continue;
    if (!seen.has(key)) seen.set(key, lead);
  }

  return Array.from(seen.values());
}

/**
 * Persist extraction progress state.
 */
async function updateExtractionState(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.EXTRACTION_STATE]: state });
}

/**
 * Finalize extraction: save leads, notify popup, show system notification.
 */
async function finalizeExtraction(message) {
  const { leads = [], state = {}, error = null } = message;

  const data = await chrome.storage.local.get(STORAGE_KEYS.LEADS);
  const existing = data[STORAGE_KEYS.LEADS] || [];
  const beforeCount = existing.length;

  const merged = deduplicateLeads([...existing, ...leads]);
  const newLeads = merged.length - beforeCount;

  const finalState = {
    ...state,
    isRunning: false,
    sessionCount: leads.length,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.LEADS]: merged,
    [STORAGE_KEYS.EXTRACTION_STATE]: finalState,
  });

  broadcastToPopup({
    action: 'EXTRACTION_COMPLETE',
    state: finalState,
    totalLeads: merged.length,
    newLeads,
    error,
  });

  if (error) {
    showSystemNotification('Extraction Error', error, true);
  } else {
    showSystemNotification(
      'Extraction Complete',
      `${newLeads} new leads extracted. Total: ${merged.length}.`,
      false
    );
  }

  return { success: true, total: merged.length, newLeads };
}

/**
 * Visit a business's own website and pull out a contact email and any
 * social media profile links from its HTML.
 *
 * This requires broad host permissions (fetching arbitrary third-party
 * sites), which is only safe/appropriate for an internally-loaded build.
 * If the manifest doesn't grant that permission, fetch() will reject and
 * this fails silently, returning empty values — so the exact same code
 * works unmodified in a restricted Chrome-Web-Store-safe build too.
 */
async function enrichLead(websiteUrl) {
  if (!websiteUrl) return { email: '', social: '' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(websiteUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return { email: '', social: '' };

    const html = await response.text();
    return {
      email: extractEmailFromHtml(html),
      social: extractSocialLinksFromHtml(html),
    };
  } catch (err) {
    // Missing permission, network error, timeout, or blocked request.
    return { email: '', social: '' };
  }
}

/**
 * Find the first plausible contact email in raw page HTML.
 */
function extractEmailFromHtml(html) {
  const matches = html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  const usable = matches.filter(
    (email) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email)
  );
  return usable[0] || '';
}

/**
 * Find social media profile links in raw page HTML.
 * Returns a single "Platform: url | Platform: url" string for easy spreadsheet display.
 */
function extractSocialLinksFromHtml(html) {
  const patterns = {
    Facebook: /https?:\/\/(www\.)?facebook\.com\/[A-Za-z0-9_.\-/]+/i,
    Instagram: /https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\-/]+/i,
    LinkedIn: /https?:\/\/(www\.)?linkedin\.com\/[A-Za-z0-9_.\-/]+/i,
    YouTube: /https?:\/\/(www\.)?youtube\.com\/[A-Za-z0-9_.\-/]+/i,
    'Twitter/X': /https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_.\-/]+/i,
  };

  const found = [];
  for (const [platform, pattern] of Object.entries(patterns)) {
    const match = html.match(pattern);
    if (match) found.push(`${platform}: ${match[0]}`);
  }

  return found.join(' | ');
}

/**
 * Send a message to the popup if it is open.
 */
function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    /* Popup may be closed — ignore */
  });
}

/**
 * Export all stored leads as a real Excel (.xlsx) file download.
 */
/**
 * Wipe all stored leads. Lets the user start a fresh topic without old
 * leads piling up and getting re-included in future exports.
 */
async function clearAllLeads() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.LEADS]: [] });
    return { success: true };
  } catch (err) {
    console.error('[Background] clearAllLeads:', err);
    return { error: err.message || 'Failed to clear leads.' };
  }
}

async function exportExcel() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.LEADS);
    const leads = data[STORAGE_KEYS.LEADS] || [];

    if (leads.length === 0) {
      return { error: 'No leads to export.' };
    }

    const groups = groupLeadsByQuery(leads);
    const timestamp = new Date().toISOString().slice(0, 10);
    const usedFilenames = new Set();
    let filesCreated = 0;

    for (const [query, groupLeads] of groups) {
      const rows = [EXCEL_HEADERS, ...groupLeads.map(leadToRow)];
      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      worksheet['!cols'] = [
        { wch: 32 },
        { wch: 22 },
        { wch: 10 },
        { wch: 14 },
        { wch: 40 },
        { wch: 18 },
        { wch: 32 },
        { wch: 28 },
        { wch: 60 },
        { wch: 24 },
        { wch: 50 },
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');

      // Encode directly as a base64 data URL instead of a blob object URL.
      // Manifest V3 background scripts run as service workers that can be
      // terminated at any time; blob object URLs created with
      // URL.createObjectURL() are tied to that worker's lifetime and become
      // invalid if the worker is torn down before chrome.downloads.download()
      // finishes reading them, causing the export to silently fail. A data
      // URL is self-contained and has no such dependency.
      const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
      const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`;

      const filename = uniqueFilename(
        `leads-${sanitizeFilenamePart(query)}-${timestamp}.xlsx`,
        usedFilenames
      );
      usedFilenames.add(filename);

      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });

      filesCreated += 1;

      // Space out downloads slightly so Chrome doesn't block/merge a burst
      // of near-simultaneous download calls.
      await sleep(400);
    }

    return { success: true, count: leads.length, files: filesCreated };
  } catch (err) {
    console.error('[Background] exportExcel:', err);
    return { error: err.message || 'Failed to export Excel file.' };
  }
}

/**
 * Convert a lead object to a spreadsheet row array.
 */
function leadToRow(lead) {
  return [
    lead.business_name || '',
    lead.category || '',
    lead.rating || '',
    lead.reviews || '',
    lead.address || '',
    lead.phone || '',
    lead.website || '',
    lead.email || '',
    lead.social || '',
    lead.search_query || '',
    lead.maps_url || '',
  ];
}

/**
 * Group leads by the search query they were extracted from, so each search
 * (e.g. "doctors near me" vs "schools near me") gets exported as its own
 * separate downloaded file. Leads with no recorded query are grouped under
 * "Uncategorized".
 */
function groupLeadsByQuery(leads) {
  const groups = new Map();

  for (const lead of leads) {
    const key = (lead.search_query || '').trim() || 'Uncategorized';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  }

  return groups;
}

/**
 * Turn a search query into a safe filename fragment: strip characters not
 * allowed in filenames, collapse whitespace into hyphens, and cap length.
 */
function sanitizeFilenamePart(name) {
  const cleaned = (name || 'leads')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return (cleaned || 'leads').slice(0, 60);
}

/**
 * Ensure filenames don't collide within this export batch (chrome.downloads
 * will otherwise auto-suffix with "(1)" itself, but we dedupe up front for
 * predictable, readable names).
 */
function uniqueFilename(name, used) {
  if (!used.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }

  return `${base}-${Date.now() % 10000}${ext}`;
}

/**
 * Simple delay helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST all leads as JSON array to the configured n8n webhook.
 */
async function sendToWebhook() {
  try {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.LEADS,
      STORAGE_KEYS.WEBHOOK_URL,
    ]);

    const leads = data[STORAGE_KEYS.LEADS] || [];
    const webhookUrl = data[STORAGE_KEYS.WEBHOOK_URL];

    if (!webhookUrl) {
      return { error: 'No webhook URL configured. Open Settings and save your n8n URL.' };
    }

    if (leads.length === 0) {
      return { error: 'No leads to send.' };
    }

    const payload = leads.map(formatLeadForWebhook);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Webhook returned ${response.status}: ${body.slice(0, 200)}`);
    }

    showSystemNotification(
      'Webhook Success',
      `Sent ${leads.length} leads to n8n.`,
      false
    );

    return { success: true, count: leads.length };
  } catch (err) {
    console.error('[Background] sendToWebhook:', err);
    showSystemNotification('Webhook Error', err.message, true);
    return { error: err.message || 'Failed to send to webhook.' };
  }
}

/**
 * Format lead object for n8n webhook JSON schema.
 */
function formatLeadForWebhook(lead) {
  return {
    business_name: lead.business_name || '',
    category: lead.category || '',
    rating: lead.rating || '',
    reviews: lead.reviews || '',
    address: lead.address || '',
    phone: lead.phone || '',
    website: lead.website || '',
    email: lead.email || '',
    social: lead.social || '',
    search_query: lead.search_query || '',
    maps_url: lead.maps_url || '',
  };
}

/**
 * Show a Chrome system notification.
 */
function showSystemNotification(title, message, isError) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: message.slice(0, 250),
    priority: isError ? 2 : 1,
  });
}
