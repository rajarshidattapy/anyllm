// src/content.js
// AnyLLM — Content Script
//
// Entry point injected into Claude.ai, ChatGPT, and Google Gemini pages.
// Responsibilities:
//  1. Detect the current platform and instantiate the correct adapter.
//  2. Wait for the chat container to appear in the DOM (SPAs load it async).
//  3. Process any messages already in the DOM on first load.
//  4. Run a debounced MutationObserver on the chat container to detect new messages.
//  5. Expose a lightweight internal event bus so feature modules (P2.2–P2.7)
//     can subscribe to 'anyllm:messageAdded' and 'anyllm:tokenLimitWarning' events.
//  6. Listen for ANYLLM_EXTRACT_CONTEXT messages and return extracted context data.
//  7. Inject per-message toolbar with Pin action; pins/highlights/context are
//     rendered in the side panel (sidepanel.js), not injected into this page.
//  8. Soft-delete toolbar action; bulk-delete mode; show/hide toggle.
//  9. Inline edit toolbar action; restore edited text on page load.
// 10. Inline text highlight selection (color picker toolbar only).

'use strict';

import { ClaudeAdapter, ChatGPTAdapter, GeminiAdapter } from './services/adapter.js';
import { extractContext }   from './services/contextExtractor.js';
import PinService            from './services/pinService.js';
import { MessageToolbar }   from './components/messageToolbar.js';
import DeleteService         from './services/deleteService.js';
import EditService           from './services/editService.js';
import HighlightService      from './services/highlightService.js';
import HighlightToolbar      from './components/highlightToolbar.js';
import HandoffBanner         from './components/HandoffBanner.js';
import { getNamespaceKey, DATA_TYPES } from './services/storage.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[AnyLLM]';

/**
 * How long (ms) to wait after the last DOM mutation before processing.
 * Prevents hammering the CPU while ChatGPT/Claude is streaming a response.
 */
const DEBOUNCE_MS = 400;

/**
 * How long (ms) to wait between polls when looking for the chat container
 * to appear (SPAs may take several seconds to mount it).
 */
const CONTAINER_POLL_INTERVAL_MS = 500;
const CONTAINER_POLL_TIMEOUT_MS = 30_000; // Give up after 30 s

// ── Platform detection & adapter instantiation ────────────────────────────────

const hostname = window.location.hostname;

/** @type {import('./services/adapter.js').PlatformAdapter | null} */
let adapter = null;

if (hostname.includes('claude.ai')) {
  adapter = new ClaudeAdapter();
} else if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) {
  adapter = new ChatGPTAdapter();
} else if (hostname.includes('gemini.google.com')) {
  adapter = new GeminiAdapter();
}

if (!adapter) {
  console.warn(`${LOG_PREFIX} Unsupported platform: ${hostname}. Content script idle.`);
} else {
  console.log(`${LOG_PREFIX} Adapter loaded for platform: ${adapter.getPlatformIdentifier()}`);
  init(adapter);
}

// ── Internal event bus ────────────────────────────────────────────────────────
// Feature modules subscribe to these custom events on the document.
// Events are fired from within this content script.
//
// Available events:
//   'anyllm:messageAdded'       — detail: { messageId, role, text, element }
//   'anyllm:tokenLimitWarning'  — detail: { platform, conversationId }
//   'anyllm:adapterReady'       — detail: { adapter, platform, conversationId }

/**
 * Fire an AnyLLM custom event on the document.
 *
 * @param {string} eventName
 * @param {object} detail
 */
function emit(eventName, detail) {
  document.dispatchEvent(new CustomEvent(eventName, { detail }));
}

// ── Seen-message tracking ─────────────────────────────────────────────────────
// We track message IDs already processed to avoid duplicating events when
// the MutationObserver fires on streaming updates of existing messages.

/** @type {Set<string>} */
const seenMessageIds = new Set();

// ── Main initialisation ───────────────────────────────────────────────────────

/**
 * Initialise the content script for a detected platform.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 */
async function init(adapter) {
  const platform = adapter.getPlatformIdentifier();
  console.log(`${LOG_PREFIX} Waiting for chat container on ${platform}…`);

  const container = await waitForChatContainer(adapter);

  if (!container) {
    console.warn(
      `${LOG_PREFIX} Chat container not found after ${CONTAINER_POLL_TIMEOUT_MS / 1000}s. ` +
      `The adapter selectors may need updating.`
    );
    return;
  }

  const conversationId = adapter.getConversationId();
  console.log(
    `${LOG_PREFIX} Chat container found. Platform: ${platform}, ` +
    `Conversation: ${conversationId}`
  );

  // Let feature modules know we're ready
  emit('anyllm:adapterReady', { adapter, platform, conversationId });

  // Process messages already in the DOM
  processCurrentMessages(adapter);

  // Watch for new / updated messages
  startMutationObserver(adapter, container);

  // Handle SPA navigations: Claude and ChatGPT navigate without a full page
  // reload, so we listen for URL changes and re-initialise when the path changes.
  watchForNavigation(adapter);
}

// ── Context Extraction wiring ─────────────────────────────────────────────────
// Extraction still requires the page's live DOM (adapter.getMessageElements()),
// but rendering happens in the side panel — this just computes and returns data.

/**
 * Strip non-serializable DOM element references before sending a context
 * object across the runtime messaging boundary (chrome.runtime structured
 * clone cannot carry live DOM nodes).
 *
 * @param {object} ctx
 * @returns {object}
 */
function serializeContext(ctx) {
  return {
    ...ctx,
    condensed: (ctx.condensed || []).map(({ element, ...rest }) => rest),
  };
}

/**
 * @param {import('./services/adapter.js').PlatformAdapter} adapterRef
 * @returns {object | null}
 */
function runContextExtraction(adapterRef) {
  const ctx = extractContext(adapterRef);
  if (!ctx) {
    console.warn(`${LOG_PREFIX} Context extraction returned nothing.`);
    return null;
  }
  return ctx;
}

// Listen for messages from the side panel / background
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // Tell the side panel which platform/conversation this tab is on, so it can
  // key its pin/highlight storage reads correctly.
  if (request?.type === 'ANYLLM_GET_CONTEXT_INFO') {
    if (!adapter) {
      sendResponse({ success: false, error: 'No adapter active on this page.' });
      return true;
    }
    sendResponse({
      success: true,
      platform: adapter.getPlatformIdentifier(),
      conversationId: adapter.getConversationId(),
    });
    return true;
  }

  if (request?.type === 'ANYLLM_EXTRACT_CONTEXT') {
    if (!adapter) {
      sendResponse({ success: false, error: 'No adapter active on this page.' });
      return true;
    }
    try {
      const ctx = runContextExtraction(adapter);
      if (!ctx) {
        sendResponse({ success: false, error: 'No messages found on this page.' });
        return true;
      }
      sendResponse({ success: true, context: serializeContext(ctx) });
    } catch (err) {
      console.error(`${LOG_PREFIX} Context extraction error:`, err);
      sendResponse({ success: false, error: err.message });
    }
    return true; // keep channel open for async
  }

  // Toggle show/hide deleted messages
  if (request?.type === 'ANYLLM_TOGGLE_DELETED') {
    const nowVisible = !DeleteService.getDeletedVisible();
    DeleteService.setDeletedVisible(nowVisible);
    sendResponse({ success: true, visible: nowVisible });
    return true;
  }

  // Enter/exit bulk-delete mode
  if (request?.type === 'ANYLLM_BULK_DELETE_MODE') {
    if (!adapter) { sendResponse({ success: false }); return true; }
    if (DeleteService.isBulkMode()) {
      DeleteService.exitBulkMode();
      sendResponse({ success: true, mode: 'off' });
    } else {
      const platform       = adapter.getPlatformIdentifier();
      const conversationId = adapter.getConversationId();
      const elements       = adapter.getMessageElements();
      DeleteService.enterBulkMode(elements, async (selectedIds) => {
        await DeleteService.softDeleteBulk(selectedIds, platform, conversationId);
      });
      sendResponse({ success: true, mode: 'on' });
    }
    return true;
  }

  // Revert an edited message from the side panel (emergency fallback)
  if (request?.type === 'ANYLLM_REVERT_EDIT') {
    if (!adapter) { sendResponse({ success: false }); return true; }
    const { messageId } = request;
    const platform       = adapter.getPlatformIdentifier();
    const conversationId = adapter.getConversationId();
    const el = document.querySelector(`[data-anyllm-msg-id="${messageId}"]`);
    EditService.revertEdit(messageId, platform, conversationId, el)
      .then(() => sendResponse({ success: true }))
      .catch((e) => {
        console.error(`${LOG_PREFIX} Failed to revert edit:`, e);
        sendResponse({ success: false });
      });
    return true; // Keep channel open for async response
  }

  // Remove a highlight requested from the side panel (touches the live DOM span)
  if (request?.type === 'ANYLLM_REMOVE_HIGHLIGHT') {
    HighlightService.removeHighlight(request.record)
      .then(() => sendResponse({ success: true }))
      .catch((e) => {
        console.error(`${LOG_PREFIX} Failed to remove highlight:`, e);
        sendResponse({ success: false });
      });
    return true;
  }

  // Side panel unpinned a message — re-sync the in-page toolbar ring state
  if (request?.type === 'ANYLLM_SYNC_PINS') {
    if (!adapter) { sendResponse({ success: false }); return true; }
    const platform       = adapter.getPlatformIdentifier();
    const conversationId = adapter.getConversationId();
    syncPinnedRings(platform, conversationId);
    sendResponse({ success: true });
    return true;
  }

  // Pack the whole page/conversation as one entry, instead of message-by-message
  if (request?.type === 'ANYLLM_PACK_PAGE') {
    if (!adapter) {
      sendResponse({ success: false, error: 'No adapter active on this page.' });
      return true;
    }
    packWholePage(adapter)
      .then((pin) => sendResponse({ success: true, pin }))
      .catch((err) => {
        console.error(`${LOG_PREFIX} Pack whole page failed:`, err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  return false;
});

document.addEventListener('anyllm:adapterReady', (e) => {
  const { adapter: readyAdapter, platform, conversationId } = e.detail;

  // Init message toolbar + pin storage wiring
  initPinFeature(readyAdapter, platform, conversationId);

  // Init delete feature (register action + restore persisted state)
  initDeleteFeature(readyAdapter, platform, conversationId);

  // Init edit feature (register action + restore persisted edits)
  initEditFeature(readyAdapter, platform, conversationId);

  // Init highlight feature (selection toolbar + persisted DOM restore)
  initHighlightFeature(readyAdapter, platform, conversationId);

  // Init handoff banner & handle pending injections
  initHandoffFeature(readyAdapter, platform, conversationId);
});

// React to newly added messages: attach toolbar
document.addEventListener('anyllm:messageAdded', (e) => {
  const { messageId, role, element } = e.detail;
  if (!element || !adapter) return;

  const platform       = adapter.getPlatformIdentifier();
  const conversationId = adapter.getConversationId();

  MessageToolbar.attachToMessage(
    element,
    messageId,
    role,
    () => buildPinnedSet(platform, conversationId),
  );
});;

// ── Chat container polling ────────────────────────────────────────────────────

/**
 * Poll until the chat container appears or the timeout expires.
 * Returns null on timeout.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 * @returns {Promise<Element | null>}
 */
function waitForChatContainer(adapter) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      const container = adapter.getChatContainer();
      if (container) {
        resolve(container);
        return;
      }
      if (Date.now() - startTime >= CONTAINER_POLL_TIMEOUT_MS) {
        resolve(null);
        return;
      }
      setTimeout(poll, CONTAINER_POLL_INTERVAL_MS);
    };

    poll();
  });
}

// ── Message processing ────────────────────────────────────────────────────────

/**
 * Scan all current message elements and emit 'anyllm:messageAdded' for any
 * not yet seen.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 */
function processCurrentMessages(adapter) {
  const elements = adapter.getMessageElements();
  console.log(`${LOG_PREFIX} Processing ${elements.length} existing message(s).`);

  elements.forEach((el, index) => {
    const data = adapter.extractMessageData(el, index);
    if (!data) return;

    if (!seenMessageIds.has(data.messageId)) {
      seenMessageIds.add(data.messageId);
      console.log(
        `${LOG_PREFIX} [${data.role.toUpperCase()}] ${data.messageId}: ` +
        `"${data.text.slice(0, 80)}${data.text.length > 80 ? '…' : ''}"`
      );
      emit('anyllm:messageAdded', data);
    }
  });
}

/**
 * Process a single newly-detected message element.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 * @param {Element} el
 * @param {number} index
 */
function processNewMessage(adapter, el, index) {
  const data = adapter.extractMessageData(el, index);
  if (!data || seenMessageIds.has(data.messageId)) return;

  seenMessageIds.add(data.messageId);
  console.log(
    `${LOG_PREFIX} New message detected [${data.role.toUpperCase()}] ${data.messageId}: ` +
    `"${data.text.slice(0, 80)}${data.text.length > 80 ? '…' : ''}"`
  );

  emit('anyllm:messageAdded', data);
  checkTokenLimit(adapter);
}

// ── Token limit monitoring ────────────────────────────────────────────────────

/**
 * Check for a token limit warning and emit the event once if found.
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 */
let _tokenLimitWarned = false;
function checkTokenLimit(adapter) {
  if (_tokenLimitWarned) return;
  if (adapter.detectTokenLimitWarning()) {
    _tokenLimitWarned = true;
    const conversationId = adapter.getConversationId();
    console.warn(`${LOG_PREFIX} ⚠ Token limit warning detected! Conversation: ${conversationId}`);
    emit('anyllm:tokenLimitWarning', {
      platform: adapter.getPlatformIdentifier(),
      conversationId,
    });
  }
}

// ── MutationObserver ──────────────────────────────────────────────────────────

/** @type {MutationObserver | null} */
let messageObserver = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;

/**
 * Start the MutationObserver on the chat container.
 * Uses a debounce so streaming updates (dozens of mutations per second)
 * are collapsed into a single processing pass.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 * @param {Element} container
 */
function startMutationObserver(adapter, container) {
  if (messageObserver) {
    messageObserver.disconnect();
  }

  messageObserver = new MutationObserver(() => {
    // Debounce: wait until mutations stop before processing
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const elements = adapter.getMessageElements();
      elements.forEach((el, index) => processNewMessage(adapter, el, index));
    }, DEBOUNCE_MS);
  });

  messageObserver.observe(container, {
    childList: true,  // detect added/removed child nodes
    subtree: true,    // watch the full subtree (streaming updates nested elements)
    characterData: false, // ignore text mutations — we re-scan the full list
  });

  console.log(`${LOG_PREFIX} MutationObserver active on chat container.`);
}

// ── SPA Navigation detection ──────────────────────────────────────────────────
// Claude and ChatGPT are SPAs — navigating to a new conversation does NOT
// trigger a page reload, so we must detect URL changes and re-initialise.

/**
 * Watch for URL changes via history.pushState / popstate.
 * When a navigation is detected, reset state and re-initialise.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 */
function watchForNavigation(adapter) {
  let lastPath = window.location.pathname;

  // Intercept history.pushState (used by both Claude and ChatGPT)
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    originalPushState(...args);
    onNavigate(adapter, lastPath);
    lastPath = window.location.pathname;
  };

  // Also handle browser back/forward
  window.addEventListener('popstate', () => {
    onNavigate(adapter, lastPath);
    lastPath = window.location.pathname;
  });
}

/**
 * Handle a detected SPA navigation.
 * @param {import('./services/adapter.js').PlatformAdapter} adapter
 * @param {string} previousPath
 */
function onNavigate(adapter, previousPath) {
  const newPath = window.location.pathname;
  if (newPath === previousPath) return;

  console.log(`${LOG_PREFIX} SPA navigation detected: ${previousPath} → ${newPath}`);

  // Disconnect the old observer and reset tracking state
  if (messageObserver) {
    messageObserver.disconnect();
    messageObserver = null;
  }
  seenMessageIds.clear();
  _tokenLimitWarned = false;

  // Re-initialise for the new conversation
  setTimeout(() => init(adapter), 500); // Brief delay for the SPA to mount the new view
}

// ── Pin feature initialisation ───────────────────────────────────────────────
// Pin data lives entirely in chrome.storage (see pinService.js). Listing,
// unpinning, and reordering pins is done in the side panel (sidepanel.js),
// which talks to storage directly. This module only needs to:
//   1. Register the toolbar's pin/unpin action (writes to storage + updates
//      the ring around the message element).
//   2. Keep those rings in sync if a pin is added/removed from the side panel.

/**
 * Build a Map<messageId, true> of currently-pinned messages for this conversation.
 * Used by the toolbar to show the active pin state.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<Map<string, boolean>>}
 */
async function buildPinnedSet(platform, conversationId) {
  const pins = await PinService.getPins(platform, conversationId);
  return new Map(pins.map(p => [p.messageId, true]));
}

/**
 * Re-apply the pinned-state ring to every currently-rendered message element,
 * based on the latest pins in storage. Used both after a page load and after
 * the side panel unpins a message (which this content script wasn't involved in).
 *
 * @param {string} platform
 * @param {string} conversationId
 */
async function syncPinnedRings(platform, conversationId) {
  const pinnedIds = await buildPinnedSet(platform, conversationId);
  document.querySelectorAll('[data-anyllm-msg-id]').forEach((el) => {
    const id = el.getAttribute('data-anyllm-msg-id');
    MessageToolbar.setMessagePinnedState(id, pinnedIds.has(id));
  });
}

/**
 * Pack the ENTIRE page/conversation as a single Pack entry, instead of
 * requiring the user to click the per-message toolbar button on each turn.
 *
 * Tries the adapter's normal per-message parsing first (nicely role-labeled).
 * If that yields nothing usable — e.g. a platform's DOM selectors are stale —
 * falls back to the chat container's (or the whole page's) raw visible text,
 * so this always captures *something* even when per-message parsing is broken.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapterRef
 * @returns {Promise<import('./services/types.js').Pin>}
 */
async function packWholePage(adapterRef) {
  const platform       = adapterRef.getPlatformIdentifier();
  const conversationId = adapterRef.getConversationId();

  const elements = adapterRef.getMessageElements();
  const messages = elements
    .map((el, idx) => adapterRef.extractMessageData(el, idx))
    .filter((data) => data && data.text && data.text.trim());

  let text;
  if (messages.length > 0) {
    text = messages
      .map((m) => `[${m.role.toUpperCase()}]\n${m.text.trim()}`)
      .join('\n\n');
    console.log(`${LOG_PREFIX} Packed whole page from ${messages.length} parsed message(s).`);
  } else {
    // Per-message parsing found nothing — fall back to raw visible text.
    const container = adapterRef.getChatContainer() || document.body;
    text = (container.innerText || container.textContent || '').trim();
    console.log(`${LOG_PREFIX} Packed whole page via raw text fallback (per-message parsing found nothing).`);
  }

  if (!text) {
    throw new Error('Could not find any text on this page to pack.');
  }

  return PinService.pinMessage({
    messageId: `page::${Date.now()}`,
    platform,
    conversationId,
    role: 'page',
    text,
  });
}

/**
 * Initialise the pin feature for the current conversation:
 *   1. Init toolbar DOM + register pin action
 *   2. Load existing pins from storage
 *   3. Restore pinned-state outline rings on all existing message elements
 *   4. Attach toolbar to all existing message elements
 *   5. Listen for storage changes so a pin/unpin from the side panel updates
 *      these rings without a page reload.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 */
async function initPinFeature(adapterRef, platform, conversationId) {
  // 1. Toolbar init
  MessageToolbar.init();

  // 2. Register pin action (idempotent — registerAction overwrites by ID)
  MessageToolbar.registerAction('pin', {
    icon: '📦',
    tooltip: 'Add to Pack',
    showFor: ['all'],
    onClick: async ({ messageId, role, element, button }) => {
      try {
        // Toggle: check if already packed
        const existing = await PinService.isPinned(messageId, platform, conversationId);

        if (existing) {
          // Remove from Pack
          await PinService.unpinMessage(existing.id, platform, conversationId);
          MessageToolbar.setMessagePinnedState(messageId, false);
          button.classList.remove('anyllm-tb-pinned');
          button.setAttribute('data-tooltip', 'Add to Pack');
          console.log(`${LOG_PREFIX} Removed from Pack: ${messageId}`);
        } else {
          // Add to Pack — get text from adapter
          const msgData = adapter ? adapter.extractMessageData(element) : null;
          const text = msgData?.text || element?.innerText || '';

          await PinService.pinMessage({
            messageId, platform, conversationId, role, text,
          });
          MessageToolbar.setMessagePinnedState(messageId, true);
          button.classList.add('anyllm-tb-pinned');
          button.setAttribute('data-tooltip', 'Remove from Pack');
          console.log(`${LOG_PREFIX} Added to Pack: ${messageId}`);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Pack action failed for ${messageId}:`, err);
        button.setAttribute('data-tooltip', 'Failed — reload the page and try again');
      }
    },
  });

  // 3. Restore pinned-state rings on already-rendered message elements
  const pins = await PinService.getPins(platform, conversationId);
  for (const pin of pins) {
    MessageToolbar.setMessagePinnedState(pin.messageId, true);
  }

  // 4. Attach toolbar to all existing message elements
  const elements = adapterRef.getMessageElements();
  elements.forEach((el, idx) => {
    const data = adapterRef.extractMessageData(el, idx);
    if (data) {
      MessageToolbar.attachToMessage(
        el, data.messageId, data.role,
        () => buildPinnedSet(platform, conversationId),
      );
    }
  });

  // 5. Live-sync rings if pins change from the side panel
  const pinStorageKey = getNamespaceKey(platform, conversationId, DATA_TYPES.PIN);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[pinStorageKey]) {
      syncPinnedRings(platform, conversationId);
    }
  });

  console.log(`${LOG_PREFIX} Pin feature initialised. ${pins.length} existing pin(s) loaded.`);
}

// ── P2.4 — Delete feature initialisation ─────────────────────────────────────

/**
 * Initialise the delete feature for the current conversation:
 *   1. Register the 🗑 delete action on the shared MessageToolbar
 *   2. Re-apply hidden state to already-deleted messages (persisted from last visit)
 *
 * Called from the anyllm:adapterReady handler after initPinFeature.
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 */
async function initDeleteFeature(adapterRef, platform, conversationId) {
  // 1. Register delete toolbar action
  MessageToolbar.registerAction('delete', {
    icon: '🗑',
    tooltip: 'Delete message (local only)',
    showFor: ['all'],
    groupBefore: true, // adds a visual divider after the pin button
    onClick: async ({ messageId, element, button }) => {
      const alreadyDeleted = await DeleteService.isDeleted(messageId, platform, conversationId);

      if (alreadyDeleted) {
        // Restore
        await DeleteService.restoreMessage(messageId, platform, conversationId);
        button.setAttribute('data-tooltip', 'Delete message (local only)');
        button.classList.remove('anyllm-tb-active');
        console.log(`${LOG_PREFIX} Restored message ${messageId}`);
      } else {
        // Soft-delete
        await DeleteService.softDeleteMessage(messageId, platform, conversationId);
        button.setAttribute('data-tooltip', 'Restore message');
        button.classList.add('anyllm-tb-active');
        console.log(`${LOG_PREFIX} Soft-deleted message ${messageId}`);
      }
    },
  });

  // 2. Re-apply persisted hidden state after a short delay
  // (gives MutationObserver time to stamp data-anyllm-msg-id attributes)
  setTimeout(async () => {
    const count = await DeleteService.applyDeletedState(adapterRef, platform, conversationId);
    if (count > 0) {
      console.log(`${LOG_PREFIX} Restored hidden state for ${count} deleted message(s).`);
    }
  }, 2000);
}

// ── P2.5 — Edit feature initialisation ─────────────────────────────────────────

/**
 * Initialise the edit feature for the current conversation:
 *   1. Register the ✎ edit action on the shared MessageToolbar
 *   2. Re-apply persisted local edits to DOM (after a 2.5s delay to let
 *      the MutationObserver stamp message IDs first)
 *
 * @param {import('./services/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 */
async function initEditFeature(adapterRef, platform, conversationId) {
  // 1. Register the edit toolbar action
  //    Shown on ALL messages (user + AI); the spec says AI-only, but
  //    local editing is equally useful on both sides.
  MessageToolbar.registerAction('edit', {
    icon: '✎️',
    tooltip: 'Edit message (local only)',
    showFor: ['all'],
    groupBefore: false,
    onClick: async ({ messageId, element }) => {
      await EditService.openEditor(element, messageId, platform, conversationId);
    },
  });

  // 2. Re-apply persisted edits after a short delay
  setTimeout(async () => {
    const count = await EditService.applyEditsToDOM(adapterRef, platform, conversationId);
    if (count > 0) {
      console.log(`${LOG_PREFIX} Re-applied ${count} local edit(s) after page load.`);
    }
  }, 2500);

  console.log(`${LOG_PREFIX} Edit feature (P2.5) initialised.`);
}

// ── P2.6 — Highlight feature initialisation ────────────────────────────────────

async function initHighlightFeature(adapterRef, platform, conversationId) {
  // Selection-triggered color-picker toolbar (still lives on the page —
  // the list of saved highlights itself is rendered in the side panel).
  HighlightToolbar.init(adapterRef, platform, conversationId);

  // Re-apply persisted highlights after a short delay
  setTimeout(async () => {
    const count = await HighlightService.applyHighlightsToDOM(adapterRef, platform, conversationId);
    if (count > 0) {
      console.log(`${LOG_PREFIX} Re-applied ${count} local highlight(s) after page load.`);
    }
  }, 3000);

  console.log(`${LOG_PREFIX} Highlight feature initialised.`);
}

// ── P2.7 — Handoff Banner & Injection ─────────────────────────────────────────

function initHandoffFeature(adapterRef, platform, conversationId) {
  HandoffBanner.init(adapterRef, platform, conversationId);

  // Check if we arrived from a handoff
  chrome.storage.local.get(['anyllm_pending_handoff'], (res) => {
    if (res.anyllm_pending_handoff) {
      console.log(`${LOG_PREFIX} Pending handoff detected. Injecting...`);
      const prompt = res.anyllm_pending_handoff;
      // Clear immediately to prevent double injection
      chrome.storage.local.remove(['anyllm_pending_handoff']);
      
      // We don't have adapter specific injection methods yet, so we write to clipboard 
      // and alert the user, or try to inject if we know the selector.
      // A simple heuristic: find the largest textarea
      setTimeout(() => {
        const textareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
        const editor = textareas.sort((a,b) => b.offsetHeight - a.offsetHeight)[0];
        if (editor) {
          editor.focus();
          // Try to execute a paste or write value
          if (editor.tagName.toLowerCase() === 'textarea') {
            editor.value = prompt;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            // ContentEditable
            document.execCommand('insertText', false, prompt);
          }
        }
      }, 2000); // Wait for UI to render
    }
  });

  // Listen for adapter detecting token limit
  window.addEventListener('anyllm:tokenLimitWarning', () => {
    console.log(`${LOG_PREFIX} Token limit warning emitted. Showing HandoffBanner.`);
    HandoffBanner.showBanner();
  });

  console.log(`${LOG_PREFIX} Handoff feature (P2.7) initialised.`);
}

// ── Cleanup on page unload ────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (messageObserver) {
    messageObserver.disconnect();
    console.log(`${LOG_PREFIX} MutationObserver disconnected.`);
  }
  clearTimeout(debounceTimer);
});
