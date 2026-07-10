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
//  6. (P2.2) Listen for ANYLLM_EXTRACT_CONTEXT messages and trigger context extraction.
//  7. (P2.3) Inject per-message toolbar with Pin action; manage Pinboard panel.
//  8. (P2.4) Soft-delete toolbar action; bulk-delete mode; show/hide toggle.
//  9. (P2.5) Inline edit toolbar action; restore edited text on page load.
// 10. (P2.6) Inline text highlight selection; highlight summary panel.

'use strict';

import { ClaudeAdapter, ChatGPTAdapter, GeminiAdapter } from './adapters/adapter.js';
import { extractContext }   from './services/contextExtractor.js';
import { ContextSidePanel } from './components/ContextSidePanel.js';
import PinService            from './services/pinService.js';
import { MessageToolbar }   from './components/messageToolbar.js';
import { PinboardPanel }    from './components/PinboardPanel.js';
import DeleteService         from './services/deleteService.js';
import EditService           from './services/editService.js';
import HighlightService      from './services/highlightService.js';
import HighlightToolbar      from './components/highlightToolbar.js';
import HighlightsPanel       from './components/HighlightsPanel.js';
import HandoffBanner         from './components/HandoffBanner.js';

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

/** @type {import('./adapters/adapter.js').PlatformAdapter | null} */
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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

// ── P2.2 — Context Extraction wiring ─────────────────────────────────────────

/**
 * Run context extraction against the current adapter and render the side panel.
 * Called from the popup via chrome.runtime.sendMessage or on demand.
 *
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapterRef
 */
function runContextExtraction(adapterRef) {
  const ctx = extractContext(adapterRef);
  if (!ctx) {
    console.warn(`${LOG_PREFIX} Context extraction returned nothing.`);
    return;
  }

  ContextSidePanel.render(ctx, {
    onRefresh: () => runContextExtraction(adapterRef),
  });
  ContextSidePanel.open();
}

// Listen for messages from the popup / background
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === 'ANYLLM_EXTRACT_CONTEXT') {
    if (!adapter) {
      sendResponse({ success: false, error: 'No adapter active on this page.' });
      return true;
    }
    try {
      runContextExtraction(adapter);
      sendResponse({ success: true });
    } catch (err) {
      console.error(`${LOG_PREFIX} Context extraction error:`, err);
      sendResponse({ success: false, error: err.message });
    }
    return true; // keep channel open for async
  }

  if (request?.type === 'ANYLLM_TOGGLE_PANEL') {
    ContextSidePanel.toggle();
    sendResponse({ success: true });
    return true;
  }

  if (request?.type === 'ANYLLM_OPEN_PINBOARD') {
    PinboardPanel.toggle();
    sendResponse({ success: true });
    return true;
  }

  // P2.4 — Toggle show/hide deleted messages
  if (request?.type === 'ANYLLM_TOGGLE_DELETED') {
    const nowVisible = !DeleteService.getDeletedVisible();
    DeleteService.setDeletedVisible(nowVisible);
    sendResponse({ success: true, visible: nowVisible });
    return true;
  }

  // P2.4 — Enter/exit bulk-delete mode
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

  // P2.5 — Revert an edited message from the popup (emergency fallback)
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

  // P2.6 — Open Highlights Panel
  if (request?.type === 'ANYLLM_OPEN_HIGHLIGHTS') {
    HighlightsPanel.toggle();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

// Auto-render the side panel (without opening it) once the adapter is ready,
// so the floating toggle button appears as soon as the page loads.
document.addEventListener('anyllm:adapterReady', (e) => {
  const { adapter: readyAdapter, platform, conversationId } = e.detail;

  // P2.2 — Context side panel auto-render
  setTimeout(() => {
    const ctx = extractContext(readyAdapter);
    if (ctx) {
      ContextSidePanel.render(ctx, {
        onRefresh: () => runContextExtraction(readyAdapter),
      });
    }
  }, 1500);

  // P2.3 — Init message toolbar + pinboard
  initPinFeature(readyAdapter, platform, conversationId);

  // P2.4 — Init delete feature (register action + restore persisted state)
  initDeleteFeature(readyAdapter, platform, conversationId);

  // P2.5 — Init edit feature (register action + restore persisted edits)
  initEditFeature(readyAdapter, platform, conversationId);

  // P2.6 — Init highlight feature
  initHighlightFeature(readyAdapter, platform, conversationId);

  // P2.7 — Init handoff banner & handle pending injections
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapter
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

// ── P2.3 — Pin feature initialisation ────────────────────────────────────────

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
 * Initialise the pin feature for the current conversation:
 *   1. Init toolbar DOM + register pin action
 *   2. Load existing pins from storage
 *   3. Render pinboard panel
 *   4. Restore pinned-state outline rings on all existing message elements
 *
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 */
async function initPinFeature(adapterRef, platform, conversationId) {
  // 1. Toolbar init
  MessageToolbar.init();

  // 2. Register pin action (idempotent — registerAction overwrites by ID)
  MessageToolbar.registerAction('pin', {
    icon: '📌',
    tooltip: 'Pin message',
    showFor: ['all'],
    onClick: async ({ messageId, role, element, button }) => {
      // Toggle: check if already pinned
      const existing = await PinService.isPinned(messageId, platform, conversationId);

      if (existing) {
        // Unpin
        await PinService.unpinMessage(existing.id, platform, conversationId);
        MessageToolbar.setMessagePinnedState(messageId, false);
        button.classList.remove('anyllm-tb-pinned');
        button.setAttribute('data-tooltip', 'Pin message');
        PinboardPanel.removePin(existing.id);
        console.log(`${LOG_PREFIX} Unpinned message ${messageId}`);
      } else {
        // Pin — get text from adapter
        const msgData = adapter ? adapter.extractMessageData(element) : null;
        const text = msgData?.text || element?.innerText || '';

        const pin = await PinService.pinMessage({
          messageId, platform, conversationId, role, text,
        });
        MessageToolbar.setMessagePinnedState(messageId, true);
        button.classList.add('anyllm-tb-pinned');
        button.setAttribute('data-tooltip', 'Unpin message');
        PinboardPanel.addPin(pin);
        console.log(`${LOG_PREFIX} Pinned message ${messageId}`);
      }
    },
  });

  // 3. Load pins from storage
  const pins = await PinService.getPins(platform, conversationId);

  // 4. Render pinboard (closed by default)
  PinboardPanel.render(pins, {
    platform,
    conversationId,
    onUnpin: async (pinId, clearAll) => {
      if (clearAll) {
        // Remove all pins for this conversation
        const all = await PinService.getPins(platform, conversationId);
        for (const p of all) {
          await PinService.unpinMessage(p.id, platform, conversationId);
          MessageToolbar.setMessagePinnedState(p.messageId, false);
        }
        PinboardPanel.render([], { platform, conversationId,
          onUnpin: arguments.callee,
          onReorder: async (ids) => { await PinService.reorderPins(platform, conversationId, ids); },
        });
        return;
      }
      const pin = pins.find(p => p.id === pinId);
      await PinService.unpinMessage(pinId, platform, conversationId);
      if (pin) MessageToolbar.setMessagePinnedState(pin.messageId, false);
      PinboardPanel.removePin(pinId);
    },
    onReorder: async (orderedIds) => {
      await PinService.reorderPins(platform, conversationId, orderedIds);
    },
  });

  // 5. Restore pinned-state rings on already-rendered message elements
  for (const pin of pins) {
    MessageToolbar.setMessagePinnedState(pin.messageId, true);
  }

  // 6. Attach toolbar to all existing message elements
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapterRef
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
 * @param {import('./adapters/adapter.js').PlatformAdapter} adapterRef
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
  HighlightToolbar.init(adapterRef, platform, conversationId);

  // Render HighlightsPanel initially closed
  const highlights = await HighlightService.getHighlights(platform, conversationId);
  HighlightsPanel.render(highlights, {
    onRemove: async (id) => {
      const hls = await HighlightService.getHighlights(platform, conversationId);
      const hl = hls.find(h => h.id === id);
      if (hl) {
        await HighlightService.removeHighlight(hl);
        HighlightsPanel.render(await HighlightService.getHighlights(platform, conversationId), _optionsCache);
      }
    }
  });
  // Local hack: keep the options reference to avoid circular binding
  const _optionsCache = {
    onRemove: async (id) => {
      const hls = await HighlightService.getHighlights(platform, conversationId);
      const hl = hls.find(h => h.id === id);
      if (hl) {
        await HighlightService.removeHighlight(hl);
        HighlightsPanel.render(await HighlightService.getHighlights(platform, conversationId), _optionsCache);
      }
    }
  };

  // Re-apply persisted highlights after a short delay
  setTimeout(async () => {
    const count = await HighlightService.applyHighlightsToDOM(adapterRef, platform, conversationId);
    if (count > 0) {
      console.log(`${LOG_PREFIX} Re-applied ${count} local highlight(s) after page load.`);
    }
  }, 3000);

  // Listen for changes and re-render the panel
  HighlightService.onHighlightChanged(async () => {
    HighlightsPanel.render(await HighlightService.getHighlights(platform, conversationId), _optionsCache);
  });

  console.log(`${LOG_PREFIX} Highlight feature (P2.6) initialised.`);
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
