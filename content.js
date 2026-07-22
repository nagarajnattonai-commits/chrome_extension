/**
 * Content script — runs on map pages.
 * Scrolls search results, extracts business data, and sends it to the background worker.
 */

const SCROLL_PAUSE_MS = 1500;
const DETAIL_LOAD_MS = 2800;
const RETRY_LOAD_MS = 1800;
const MAX_SCROLL_ATTEMPTS = 30;
const SCROLL_STEP_PX = 400;

/** Flag controlled by popup/background to stop extraction mid-run. */
let extractionStopped = false;

/**
 * Listen for commands from the popup.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  switch (message.action) {
    case 'CHECK_PAGE':
      return checkPage();

    case 'START_EXTRACTION':
      extractionStopped = false;
      runExtraction().catch((err) => {
        chrome.runtime.sendMessage({
          action: 'EXTRACTION_ERROR',
          error: err.message || 'Extraction failed unexpectedly.',
        });
      });
      return { success: true, message: 'Extraction started.' };

    case 'STOP_EXTRACTION':
      extractionStopped = true;
      return { success: true };

    default:
      return { error: 'Unknown action' };
  }
}

/**
 * Check whether the current page has searchable result listings.
 */
function checkPage() {
  if (!isGoogleMapsPage()) {
    return { isSearchPage: false, message: 'Not on a business search page.' };
  }

  const feed = getResultsFeed();
  const listings = getListingLinks();

  if (!feed && listings.length === 0) {
    return {
      isSearchPage: false,
      message: 'No search results found. Run a search like "dentists in Bangalore" first.',
    };
  }

  return { isSearchPage: true, listingCount: listings.length };
}

function isGoogleMapsPage() {
  return /google\.[a-z.]+\/maps|maps\.google\./.test(window.location.href);
}

/**
 * Main extraction pipeline: scroll → collect links → visit each → extract details.
 */
async function runExtraction() {
  if (!isGoogleMapsPage()) {
    await notifyComplete([], {}, 'Business search page not detected.');
    return;
  }

  try {
    await chrome.runtime.sendMessage({ action: 'RESET_STOP' });
  } catch {
    /* ignore */
  }

  extractionStopped = false;

  await reportProgress({
    isRunning: true,
    processed: 0,
    total: 0,
    sessionCount: 0,
    detail: 'Finding results…',
    phase: 'scrolling',
  });

  const feed = getResultsFeed();

  if (!feed && getListingLinks().length === 0) {
    await notifyComplete([], {}, 'Results panel not found. Make sure search results are visible.');
    return;
  }

  const leads = [];
  const processedKeys = new Set();
  const searchQuery = getCurrentSearchQuery();

  if (feed) feed.scrollTop = 0;
  await sleep(400);

  let staleRounds = 0;
  let round = 0;

  // Process listings incrementally as they're discovered, rather than
  // collecting every link up front and clicking them long afterward.
  // Google Maps recycles (removes/reuses) off-screen list DOM elements as
  // you scroll, so a link found now may no longer exist by the time a
  // later click gets around to it. Handling each business shortly after
  // it appears — while it's still on screen — avoids that entirely.
  while (staleRounds < 3 && round < MAX_SCROLL_ATTEMPTS * 4) {
    if (await shouldStop()) break;
    round++;

    const currentLinks = getListingLinks();
    let foundNewThisRound = false;

    for (const link of currentLinks) {
      if (await shouldStop()) break;

      const key = listingKey(link);
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);
      foundNewThisRound = true;

      await reportProgress({
        isRunning: true,
        processed: processedKeys.size,
        total: processedKeys.size,
        sessionCount: leads.length,
        detail: `Extracting ${processedKeys.size}… (${leads.length} collected)`,
        phase: 'extracting',
      });

      const mapsUrl = normalizeMapsUrl(link.href);

      try {
        // Visit the actual detail page for every listing — no guessing at
        // card text, no positional heuristics. This is slower but reads
        // real, individually-labeled DOM elements (address button, phone
        // button, website link) instead of trying to reverse-engineer
        // meaning from an unlabeled list of text fragments.
        link.scrollIntoView({ behavior: 'instant', block: 'center' });
        await sleep(300);
        link.click();

        // A generous fixed wait, not clever navigation/name-matching
        // detection — simpler and more predictable to reason about, even
        // though it makes extraction slower overall.
        await sleep(DETAIL_LOAD_MS);

        let lead = extractDetailPanel(mapsUrl);

        // If nothing loaded yet (slow render/network), wait once more
        // before giving up — a single bounded retry, not an open-ended
        // polling loop.
        if (!lead.business_name) {
          await sleep(RETRY_LOAD_MS);
          lead = extractDetailPanel(mapsUrl);
        }

        lead.search_query = searchQuery;

        if (lead.website) {
          try {
            const enrichment = await chrome.runtime.sendMessage({
              action: 'ENRICH_LEAD',
              website: lead.website,
            });
            lead.email = enrichment?.email || '';
            lead.social = enrichment?.social || '';
          } catch {
            lead.email = '';
            lead.social = '';
          }
        } else {
          lead.email = '';
          lead.social = '';
        }

        if (lead.business_name) {
          leads.push(lead);
        } else {
          leads.push(createEmptyLead(mapsUrl));
        }
      } catch (err) {
        console.warn('[Extractor] Failed to extract listing:', mapsUrl, err);
        leads.push(createEmptyLead(mapsUrl));
      }
    }

    if (await shouldStop()) break;

    if (!foundNewThisRound) {
      staleRounds++;
    } else {
      staleRounds = 0;
    }

    if (feed) {
      const before = feed.scrollTop;
      feed.scrollTop += SCROLL_STEP_PX * 3;
      await sleep(SCROLL_PAUSE_MS);
      // If scrolling didn't move at all, we've hit the bottom of the list.
      if (feed.scrollTop === before) staleRounds++;
    } else {
      // No scrollable feed (e.g. a short list) — nothing more to load.
      break;
    }
  }

  await notifyComplete(leads, {
    isRunning: false,
    processed: processedKeys.size,
    total: processedKeys.size,
    sessionCount: leads.length,
    detail: extractionStopped ? 'Stopped by user.' : 'Done!',
    phase: 'done',
  });
}

/**
 * Build a stable de-duplication key for a listing using the normalized
 * Google Maps place URL only.
 */
function listingKey(link) {
  return normalizeMapsUrl(link.href);
}

/**
 * Find the scrollable search-results feed container.
 */
function getResultsFeed() {
  return (
    document.querySelector('div[role="feed"]') ||
    document.querySelector('[aria-label*="Results for"]')?.closest('div[role="main"]') ||
    document.querySelector('.m6QErb[aria-label]')
  );
}

/**
 * Collect place listing anchors from the results panel, filtering out
 * duplicate anchors that point to the same normalized Maps URL. Google
 * Maps often renders more than one clickable element per business card
 * (e.g. the thumbnail and the name both link to the same place), so this
 * keeps only the first one seen per unique business.
 */
function getListingLinks() {
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/maps/place/"]');

  return Array.from(anchors).filter((a) => {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/maps/place/') || a.offsetParent === null) return false;

    const normalized = normalizeMapsUrl(href);
    if (seen.has(normalized)) return false;

    seen.add(normalized);
    return true;
  });
}

/**
 * Normalize a Google Maps place URL for de-duplication and navigation
 * matching.
 *
 * Google Maps is inconsistent about how it encodes spaces in the business
 * name segment of the URL — sometimes "+", sometimes "%20" (a real space
 * after decoding). decodeURIComponent() does NOT convert "+" to a space
 * (only percent-encoding does), so without handling this, the same
 * business can normalize to two different strings depending on where the
 * URL came from (the sidebar link vs. the URL after actually navigating
 * there) — which breaks navigation-confirmation matching entirely. We
 * treat "+" and encoded spaces as equivalent here to fix that.
 */
function normalizeMapsUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    const match = parsed.pathname.match(/\/maps\/place\/([^/]+)/);
    const raw = match ? decodeURIComponent(match[1]) : parsed.href.split('?')[0];
    return raw.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  } catch {
    return url.replace(/\+/g, ' ').toLowerCase();
  }
}

function extractDetailPanel(mapsUrl) {
  const lead = createEmptyLead(mapsUrl);

  lead.business_name = extractText([
    'h1.DUwDvf',
    'h1[class*="fontHeadlineLarge"]',
    'div[role="main"] h1',
    '[data-attrid="title"]',
  ]) || extractFromAriaLabel();

  lead.rating = extractRating();
  lead.reviews = extractReviewCount();
  lead.category = extractCategory();
  lead.address = extractAddress();
  lead.phone = extractPhone();
  lead.website = extractWebsite();

  if (!lead.business_name) {
    const cardData = extractFromListingCard(mapsUrl);
    Object.assign(lead, { ...cardData, ...pickNonEmpty(lead) });
  }

  return lead;
}

/**
 * Try multiple CSS selectors and return the first non-empty text result.
 */
function extractText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return '';
}

/**
 * Parse business name from a listing card aria-label as fallback.
 */
function extractFromAriaLabel() {
  const link = document.querySelector('a[href*="/maps/place/"][aria-label]');
  if (!link) return '';

  const label = link.getAttribute('aria-label') || '';
  const parts = label.split('·').map((p) => p.trim());
  return parts[0] || '';
}

/**
 * Extract star rating from aria-label (e.g. "4.5 stars").
 */
function extractRating() {
  // Scope the search near the title/header rather than the whole
  // document — Google Maps also has a "Rate and review" widget further
  // down the panel with individual star buttons (aria-label like
  // "Rate 4 stars"), which an unscoped, loosely-matched query can
  // accidentally grab instead of the business's actual rating.
  const titleEl = document.querySelector(
    'h1.DUwDvf, h1[class*="fontHeadlineLarge"], div[role="main"] h1, [data-attrid="title"]'
  );
  const scope = titleEl?.closest('div')?.parentElement || document;

  const candidates = scope.querySelectorAll(
    'span[role="img"][aria-label*="star"], [aria-label*="stars"]'
  );

  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    // Explicitly reject the review-submission widget's own star buttons
    // (e.g. "Rate 4 stars") — these are not the business's rating.
    if (/^rate\b/i.test(label.trim())) continue;

    const match = label.match(/^([\d.]+)\s*star/i);
    if (match) return match[1];
  }

  return '';
}

/**
 * Extract review count (e.g. "123 reviews" → "123").
 */
function extractReviewCount() {
  const titleEl = document.querySelector(
    'h1.DUwDvf, h1[class*="fontHeadlineLarge"], div[role="main"] h1, [data-attrid="title"]'
  );
  const scope = titleEl?.closest('div')?.parentElement || document;

  const candidates = scope.querySelectorAll(
    'button[aria-label*="review"], span[aria-label*="review"], [jsaction*="reviews"]'
  );

  for (const el of candidates) {
    const text = el.getAttribute('aria-label') || el.textContent || '';
    const match = text.match(/([\d,]+)\s*review/i);
    if (match) return match[1].replace(/,/g, '');
  }

  // Fallback: a "(1,234)" style count directly next to the rating, but
  // still scoped near the header — NOT a whole-document span scan, which
  // risked matching unrelated parenthesized numbers anywhere on the page
  // (photo counts, pagination, etc.) and was the actual cause of every
  // business showing the same wrong review count.
  const scopedSpans = scope.querySelectorAll('span');
  for (const span of scopedSpans) {
    const text = span.textContent?.trim() || '';
    if (/^\([\d,]+\)$/.test(text)) return text.replace(/[(),]/g, '');
    if (/^[\d,]+ reviews?$/i.test(text)) return text.replace(/[^\d]/g, '');
  }

  return '';
}

/**
 * Extract business category/type.
 */
function extractCategory() {
  const btn = document.querySelector(
    'button[jsaction*="category"], button[jsaction*="pane.category"]'
  );
  if (btn?.textContent?.trim()) return btn.textContent.trim();

  const categoryEl = document.querySelector('[jsaction*="category"]');
  return categoryEl?.textContent?.trim() || '';
}

/**
 * Extract street address from the detail panel.
 */
function extractAddress() {
  const addressBtn =
    document.querySelector('button[data-item-id="address"]') ||
    document.querySelector('[data-item-id*="address"]') ||
    document.querySelector('button[aria-label^="Address:"]');

  if (addressBtn) {
    const label = addressBtn.getAttribute('aria-label') || '';
    if (label.startsWith('Address:')) return label.replace(/^Address:\s*/i, '').trim();
    return addressBtn.textContent?.trim() || '';
  }

  return extractText(['[data-attrid="kc:/location/location:address"]']);
}

/**
 * Extract phone number from the detail panel.
 */
function extractPhone() {
  const phoneBtn =
    document.querySelector('button[data-item-id*="phone"]') ||
    document.querySelector('button[aria-label*="Phone:"]') ||
    document.querySelector('[data-tooltip="Copy phone number"]');

  if (phoneBtn) {
    const label = phoneBtn.getAttribute('aria-label') || '';
    const phoneMatch = label.match(/Phone:\s*(.+)/i);
    if (phoneMatch) return phoneMatch[1].trim();
    return phoneBtn.textContent?.trim() || label.trim();
  }

  return '';
}

/**
 * Extract website URL from the detail panel.
 */
function extractWebsite() {
  const websiteLink =
    document.querySelector('a[data-item-id="authority"]') ||
    document.querySelector('a[aria-label*="Website:"]') ||
    document.querySelector('a[data-tooltip="Open website"]');

  if (websiteLink) {
    return websiteLink.href || websiteLink.getAttribute('aria-label')?.replace(/^Website:\s*/i, '') || '';
  }

  return '';
}

/**
 * Fallback: parse listing card text for basic fields without detail panel.
 */
function extractFromListingCard(mapsUrl) {
  const link = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'))
    .find((a) => normalizeMapsUrl(a.href) === normalizeMapsUrl(mapsUrl));

  if (!link) return {};

  const container = link.closest('[role="article"]') || link.parentElement?.parentElement;
  if (!container) return { business_name: link.getAttribute('aria-label')?.split('·')[0]?.trim() || '' };

  const texts = Array.from(container.querySelectorAll('span'))
    .map((s) => s.textContent?.trim())
    .filter(Boolean);

  return {
    business_name: texts[0] || '',
    rating: texts.find((t) => /^[\d.]+$/.test(t)) || '',
    reviews: texts.find((t) => /^\([\d,]+\)$/.test(t))?.replace(/[(),]/g, '') || '',
    category: texts.find((t) => !/^[\d.()]+$/.test(t) && t !== texts[0]) || '',
  };
}

/**
 * Read the text currently in the search box, so each extracted lead can be
 * tagged with which search it came from (e.g. "doctors near me").
 */
function getCurrentSearchQuery() {
  const input =
    document.querySelector('#searchboxinput') ||
    document.querySelector('input[aria-label*="Search"]') ||
    document.querySelector('input[name="q"]');

  const value = input?.value?.trim();
  if (value) return value;

  // Fallback: pull the query out of the page title, e.g. "doctors near me - Google Maps"
  const title = document.title || '';
  return title.replace(/\s*-\s*(Google\s*)?Maps\s*$/i, '').trim() || 'Untitled search';
}

/**
 * Create an empty lead object with the required schema.
 */
function createEmptyLead(mapsUrl) {
  return {
    business_name: '',
    category: '',
    rating: '',
    reviews: '',
    address: '',
    phone: '',
    website: '',
    email: '',
    social: '',
    search_query: '',
    maps_url: mapsUrl,
  };
}

/** Return only non-empty values from a lead object. */
function pickNonEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
}

/**
 * Check if extraction should stop (local flag or background signal).
 */
async function shouldStop() {
  if (extractionStopped) return true;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'SHOULD_STOP' });
    if (response?.stop) extractionStopped = true;
  } catch {
    /* background unavailable */
  }

  return extractionStopped;
}

/**
 * Report extraction progress to background/popup.
 */
async function reportProgress(state) {
  try {
    await chrome.runtime.sendMessage({ action: 'EXTRACTION_PROGRESS', state });
  } catch {
    /* popup may be closed */
  }
}

/**
 * Send final leads to background for storage and notify popup.
 */
async function notifyComplete(leads, state, error = null) {
  try {
    await chrome.runtime.sendMessage({
      action: 'EXTRACTION_DONE',
      leads,
      state,
      error,
    });
  } catch (err) {
    console.error('[Extractor] notifyComplete:', err);
  }
}

/** Promise-based sleep utility. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
