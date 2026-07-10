// src/services/deleteService.js
// AnyLLM — Delete Service (P2.4)
//
// Implements a purely view-layer soft-delete: message elements are hidden in
// the DOM with a CSS class; the message IDs are persisted in storage so the
// hidden state survives page refreshes.
//
// Key design decisions:
//   • "Soft" only — no LLM data is mutated; just DOM visibility.
//   • IDs are stored per-conversation under DATA_TYPES.DELETED.
//   • Bulk delete mode: a temporary Set of selected IDs accumulates, then
//     committed all at once via softDeleteBulk().
//   • Show/hide toggle: `setDeletedVisible(bool)` toggles a global CSS rule
//     that reveals all hidden messages without removing storage records.
//
// Public API:
//   softDeleteMessage(messageId, platform, conversationId)
//   restoreMessage(messageId, platform, conversationId)
//   getDeletedIds(platform, conversationId)          → Set<string>
//   isDeleted(messageId, platform, conversationId)   → Promise<boolean>
//   softDeleteBulk(messageIds[], platform, conversationId)
//   restoreAll(platform, conversationId)
//   applyDeletedState(adapter, platform, conversationId)  ← call on page load
//   setDeletedVisible(visible)    ← show/hide all soft-deleted messages
//   onDeletedChanged(cb) / offDeletedChanged(cb)

'use strict';

import {
  DATA_TYPES,
  getCollection,
  setCollection,
  createDeletedMessage,
} from './storage.js';

// ── CSS class & style injection ───────────────────────────────────────────────

const HIDDEN_CLASS   = 'anyllm-deleted-hidden';
const REVEALED_CLASS = 'anyllm-deleted-revealed';
const STYLE_ID       = 'anyllm-delete-styles';

/**
 * Inject the global CSS rules for soft-deleted messages (once).
 */
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* AnyLLM — soft-deleted message state */

/* Hidden: collapse with a fade-out and a subtle placeholder */
.${HIDDEN_CLASS} {
  position: relative;
  overflow: hidden;
  max-height: 0 !important;
  opacity: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  pointer-events: none;
  transition: max-height 0.25s ease, opacity 0.2s ease;
}

/* Revealed: show with a dimmed, faded look so it's clearly not "real" */
.${HIDDEN_CLASS}.${REVEALED_CLASS} {
  max-height: 2000px !important;
  opacity: 0.35 !important;
  pointer-events: auto;
  outline: 2px dashed rgba(239, 68, 68, 0.35) !important;
  outline-offset: 2px !important;
  border-radius: 4px;
  filter: grayscale(40%);
  transition: max-height 0.25s ease, opacity 0.2s ease;
}

/* "Deleted" badge shown when message is in revealed state */
.${HIDDEN_CLASS}.${REVEALED_CLASS}::before {
  content: '🗑 Deleted (local view only)';
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 10px;
  font-weight: 600;
  color: rgba(239, 68, 68, 0.7);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 4px;
  padding: 2px 7px;
  z-index: 10;
  pointer-events: none;
}

/* Bulk-select checkbox overlay on message hover */
.anyllm-bulk-checkbox {
  position: absolute;
  top: 10px;
  left: -28px;
  width: 18px;
  height: 18px;
  accent-color: #ef4444;
  cursor: pointer;
  z-index: 20;
  opacity: 0;
  transition: opacity 0.15s;
}
.anyllm-bulk-mode [data-anyllm-msg-id] {
  position: relative;
}
.anyllm-bulk-mode .anyllm-bulk-checkbox {
  opacity: 1;
}

/* Bulk-mode banner */
#anyllm-bulk-banner {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483638;
  background: rgba(15, 17, 27, 0.96);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 14px;
  padding: 10px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  color: #e2e8f0;
  backdrop-filter: blur(10px);
}
#anyllm-bulk-banner-count {
  color: #f87171;
  font-weight: 700;
}
.anyllm-bulk-action-btn {
  padding: 6px 16px;
  border-radius: 8px;
  border: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.anyllm-bulk-action-btn.delete {
  background: linear-gradient(135deg, #dc2626, #ef4444);
  color: #fff;
}
.anyllm-bulk-action-btn.delete:hover { background: linear-gradient(135deg, #b91c1c, #dc2626); }
.anyllm-bulk-action-btn.cancel {
  background: rgba(255,255,255,0.06);
  color: #94a3b8;
  border: 1px solid rgba(255,255,255,0.1);
}
.anyllm-bulk-action-btn.cancel:hover { background: rgba(255,255,255,0.1); }
`;
  document.head.appendChild(style);
}

// ── Change listeners ──────────────────────────────────────────────────────────

/** @type {Set<Function>} */
const _listeners = new Set();

function _notify(event, detail) {
  _listeners.forEach(cb => {
    try { cb(event, detail); } catch (e) {
      console.error('[AnyLLM][DeleteService] Listener error:', e);
    }
  });
}

function onDeletedChanged(cb)  { _listeners.add(cb); }
function offDeletedChanged(cb) { _listeners.delete(cb); }

// ── Global show/hide state ────────────────────────────────────────────────────

let _showDeleted = false;

/**
 * Toggle global visibility of all soft-deleted messages without touching storage.
 * @param {boolean} visible
 */
function setDeletedVisible(visible) {
  _showDeleted = visible;
  document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach(el => {
    el.classList.toggle(REVEALED_CLASS, visible);
  });
  _notify('visibilityChanged', { visible });
}

/** @returns {boolean} */
function getDeletedVisible() { return _showDeleted; }

// ── Storage helpers ───────────────────────────────────────────────────────────

/**
 * Load all deleted message records for a conversation.
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<import('./types.js').DeletedMessage[]>}
 */
async function _loadRecords(platform, conversationId) {
  return getCollection(platform, conversationId, DATA_TYPES.DELETED);
}

/**
 * Save the full records array back to storage.
 * @param {string} platform
 * @param {string} conversationId
 * @param {import('./types.js').DeletedMessage[]} records
 */
async function _saveRecords(platform, conversationId, records) {
  return setCollection(platform, conversationId, DATA_TYPES.DELETED, records);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Find the message element in the DOM by messageId attribute.
 * @param {string} messageId
 * @returns {Element | null}
 */
function _findElement(messageId) {
  return document.querySelector(`[data-anyllm-msg-id="${messageId}"]`);
}

/**
 * Apply the hidden class to a DOM element.
 * @param {Element} el
 */
function _hideElement(el) {
  el.classList.add(HIDDEN_CLASS);
  if (_showDeleted) el.classList.add(REVEALED_CLASS);
}

/**
 * Remove hidden class from a DOM element.
 * @param {Element} el
 */
function _showElement(el) {
  el.classList.remove(HIDDEN_CLASS, REVEALED_CLASS);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Soft-delete a single message: hide it in DOM and persist its ID.
 *
 * @param {string} messageId
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<import('./types.js').DeletedMessage>}
 */
async function softDeleteMessage(messageId, platform, conversationId) {
  ensureStyles();

  // Persist
  const records = await _loadRecords(platform, conversationId);
  if (records.find(r => r.messageId === messageId)) {
    // Already deleted — idempotent
    return records.find(r => r.messageId === messageId);
  }

  const record = createDeletedMessage({ platform, conversationId, messageId });
  records.push(record);
  await _saveRecords(platform, conversationId, records);

  // Apply DOM change
  const el = _findElement(messageId);
  if (el) _hideElement(el);

  console.log(`[AnyLLM][DeleteService] Soft-deleted message ${messageId}`);
  _notify('deleted', { messageId, platform, conversationId });
  return record;
}

/**
 * Restore a soft-deleted message: show it in DOM and remove storage record.
 *
 * @param {string} messageId
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
async function restoreMessage(messageId, platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  const updated = records.filter(r => r.messageId !== messageId);

  if (updated.length === records.length) return false; // wasn't deleted

  await _saveRecords(platform, conversationId, updated);

  const el = _findElement(messageId);
  if (el) _showElement(el);

  console.log(`[AnyLLM][DeleteService] Restored message ${messageId}`);
  _notify('restored', { messageId, platform, conversationId });
  return true;
}

/**
 * Check if a message is currently soft-deleted.
 *
 * @param {string} messageId
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
async function isDeleted(messageId, platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  return records.some(r => r.messageId === messageId);
}

/**
 * Get a Set of all deleted message IDs for a conversation.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<Set<string>>}
 */
async function getDeletedIds(platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  return new Set(records.map(r => r.messageId));
}

/**
 * Bulk soft-delete a list of message IDs at once.
 *
 * @param {string[]} messageIds
 * @param {string}   platform
 * @param {string}   conversationId
 * @returns {Promise<void>}
 */
async function softDeleteBulk(messageIds, platform, conversationId) {
  ensureStyles();

  const records = await _loadRecords(platform, conversationId);
  const existingIds = new Set(records.map(r => r.messageId));

  const newRecords = messageIds
    .filter(id => !existingIds.has(id))
    .map(id => createDeletedMessage({ platform, conversationId, messageId: id }));

  await _saveRecords(platform, conversationId, [...records, ...newRecords]);

  // Apply DOM changes
  for (const id of messageIds) {
    const el = _findElement(id);
    if (el) _hideElement(el);
  }

  console.log(`[AnyLLM][DeleteService] Bulk-deleted ${newRecords.length} message(s)`);
  _notify('bulkDeleted', { messageIds, platform, conversationId });
}

/**
 * Restore all soft-deleted messages in a conversation.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<void>}
 */
async function restoreAll(platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  for (const r of records) {
    const el = _findElement(r.messageId);
    if (el) _showElement(el);
  }
  await _saveRecords(platform, conversationId, []);
  console.log(`[AnyLLM][DeleteService] Restored all ${records.length} deleted message(s)`);
  _notify('restoredAll', { platform, conversationId });
}

/**
 * On page load / SPA navigation: re-apply the hidden CSS class to all
 * previously soft-deleted messages so the state survives refreshes.
 *
 * Must be called AFTER the adapter has populated the DOM with message elements
 * (i.e. after the MutationObserver has fired the initial processCurrentMessages).
 *
 * @param {import('../adapters/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<number>} count of elements re-hidden
 */
async function applyDeletedState(adapterRef, platform, conversationId) {
  ensureStyles();

  const deletedIds = await getDeletedIds(platform, conversationId);
  if (deletedIds.size === 0) return 0;

  let count = 0;
  const elements = adapterRef.getMessageElements();

  elements.forEach((el, idx) => {
    const data = adapterRef.extractMessageData(el, idx);
    if (!data) return;
    if (deletedIds.has(data.messageId)) {
      // Stamp the data attribute so _findElement works later
      el.setAttribute('data-anyllm-msg-id', data.messageId);
      _hideElement(el);
      count++;
    }
  });

  console.log(`[AnyLLM][DeleteService] Re-applied hidden state to ${count} message(s) after load`);
  return count;
}

// ── Bulk-delete mode ──────────────────────────────────────────────────────────

/** @type {Set<string>} */
let _bulkSelection = new Set();
let _bulkMode = false;

/** @type {Function | null} */
let _onBulkCommit = null;

/**
 * Enter bulk-delete mode: show checkboxes on every message element.
 *
 * @param {NodeList | Element[]} messageElements
 * @param {Function} onCommit   — (selectedIds: string[]) => void
 */
function enterBulkMode(messageElements, onCommit) {
  if (_bulkMode) return;
  _bulkMode      = true;
  _bulkSelection = new Set();
  _onBulkCommit  = onCommit;

  ensureStyles();
  document.body.classList.add('anyllm-bulk-mode');

  // Inject checkboxes into each message element
  messageElements.forEach(el => {
    const msgId = el.getAttribute('data-anyllm-msg-id');
    if (!msgId) return;

    const cb = document.createElement('input');
    cb.type      = 'checkbox';
    cb.className = 'anyllm-bulk-checkbox';
    cb.dataset.msgId = msgId;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        _bulkSelection.add(msgId);
      } else {
        _bulkSelection.delete(msgId);
      }
      _updateBulkBanner();
    });
    el.appendChild(cb);
  });

  _showBulkBanner();
}

function _showBulkBanner() {
  if (document.getElementById('anyllm-bulk-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'anyllm-bulk-banner';
  banner.innerHTML = `
    <span>Selected: <strong id="anyllm-bulk-banner-count">0</strong> message(s)</span>
    <button class="anyllm-bulk-action-btn delete" id="anyllm-bulk-delete-btn">🗑 Delete Selected</button>
    <button class="anyllm-bulk-action-btn cancel" id="anyllm-bulk-cancel-btn">Cancel</button>
  `;
  document.body.appendChild(banner);

  document.getElementById('anyllm-bulk-delete-btn').addEventListener('click', () => {
    const ids = [..._bulkSelection];
    if (ids.length === 0) return;
    if (typeof _onBulkCommit === 'function') _onBulkCommit(ids);
    exitBulkMode();
  });

  document.getElementById('anyllm-bulk-cancel-btn').addEventListener('click', exitBulkMode);
}

function _updateBulkBanner() {
  const countEl = document.getElementById('anyllm-bulk-banner-count');
  if (countEl) countEl.textContent = String(_bulkSelection.size);
}

/**
 * Exit bulk-delete mode: remove checkboxes and banner.
 */
function exitBulkMode() {
  _bulkMode      = false;
  _bulkSelection = new Set();
  _onBulkCommit  = null;

  document.body.classList.remove('anyllm-bulk-mode');
  document.querySelectorAll('.anyllm-bulk-checkbox').forEach(el => el.remove());
  document.getElementById('anyllm-bulk-banner')?.remove();
}

/** @returns {boolean} */
function isBulkMode() { return _bulkMode; }

// ── Public API ────────────────────────────────────────────────────────────────

const DeleteService = Object.freeze({
  softDeleteMessage,
  restoreMessage,
  isDeleted,
  getDeletedIds,
  softDeleteBulk,
  restoreAll,
  applyDeletedState,
  enterBulkMode,
  exitBulkMode,
  isBulkMode,
  setDeletedVisible,
  getDeletedVisible,
  onDeletedChanged,
  offDeletedChanged,
  HIDDEN_CLASS,
  REVEALED_CLASS,
});

export default DeleteService;
export {
  softDeleteMessage,
  restoreMessage,
  isDeleted,
  getDeletedIds,
  softDeleteBulk,
  restoreAll,
  applyDeletedState,
  enterBulkMode,
  exitBulkMode,
  isBulkMode,
  setDeletedVisible,
  getDeletedVisible,
  onDeletedChanged,
  offDeletedChanged,
};
