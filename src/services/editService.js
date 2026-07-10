// src/services/editService.js
// AnyLLM — Edit Service (P2.5)
//
// Allows users to locally edit any message element (user OR AI) in the DOM.
// Edits are purely local — no LLM session data is mutated.
//
// Storage schema (DATA_TYPES.EDIT per conversation):
//   [{
//     id:             string   — unique record ID
//     platform:       string
//     conversationId: string
//     messageId:      string   — matches data-anyllm-msg-id attribute
//     originalText:   string   — raw innerText at the moment of first edit
//     editedText:     string   — the user-saved version
//     editedAt:       number   — Unix ms of last save
//     history:        [{text, savedAt}]  — full edit history (max 10 entries)
//   }]
//
// Public API:
//   saveEdit(messageId, newText, platform, conversationId)
//   revertEdit(messageId, platform, conversationId)
//   getEdit(messageId, platform, conversationId)   → Edit | null
//   hasEdit(messageId, platform, conversationId)   → Promise<boolean>
//   applyEditsToDOM(adapterRef, platform, conversationId)
//   onEditChanged(cb) / offEditChanged(cb)

'use strict';

import {
  DATA_TYPES,
  getCollection,
  setCollection,
  createEdit,
} from './storage.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HISTORY = 10;

// CSS class stamped on elements that have a local edit applied
const EDITED_CLASS   = 'anyllm-edited-msg';
const EDITING_CLASS  = 'anyllm-editing-active';
const STYLE_ID       = 'anyllm-edit-styles';

// ── Injected styles ───────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* AnyLLM — edit service injected styles */

/* Edited-message indicator chip */
.anyllm-edit-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  font-size: 10.5px;
  font-weight: 600;
  color: #818cf8;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.22);
  border-radius: 5px;
  padding: 1px 7px;
  vertical-align: middle;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;
}
.anyllm-edit-badge:hover {
  background: rgba(99, 102, 241, 0.18);
}
.anyllm-edit-badge .anyllm-revert-icon {
  font-size: 11px;
  opacity: 0.7;
}

/* Edited message: subtle left border */
.${EDITED_CLASS} {
  border-left: 2px solid rgba(99, 102, 241, 0.4) !important;
  padding-left: 6px !important;
  border-radius: 3px;
}

/* Inline edit widget overlay */
.anyllm-edit-overlay {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0;
  z-index: 10;
}

.anyllm-edit-textarea {
  width: 100%;
  min-height: 80px;
  max-height: 60vh;
  background: rgba(10, 12, 20, 0.95);
  border: 1.5px solid rgba(99, 102, 241, 0.5);
  border-radius: 8px;
  color: #e2e8f0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13.5px;
  line-height: 1.6;
  padding: 10px 12px;
  resize: vertical;
  outline: none;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.anyllm-edit-textarea:focus {
  border-color: rgba(99, 102, 241, 0.75);
  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
}

.anyllm-edit-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.anyllm-edit-btn {
  padding: 6px 14px;
  border-radius: 7px;
  border: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.anyllm-edit-btn.save {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
}
.anyllm-edit-btn.save:hover { background: linear-gradient(135deg, #4f46e5, #7c3aed); transform: translateY(-1px); }
.anyllm-edit-btn.cancel {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: #94a3b8;
}
.anyllm-edit-btn.cancel:hover { background: rgba(255,255,255,0.1); }
.anyllm-edit-btn.revert {
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.2);
  color: #f87171;
}
.anyllm-edit-btn.revert:hover { background: rgba(239,68,68,0.14); }

.anyllm-edit-charcount {
  margin-left: auto;
  font-size: 10.5px;
  color: #4b5563;
}

/* History dropdown */
.anyllm-edit-history-btn {
  background: rgba(99,102,241,0.08);
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 7px;
  color: #818cf8;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  padding: 5px 10px;
  transition: background 0.15s;
}
.anyllm-edit-history-btn:hover { background: rgba(99,102,241,0.15); }

.anyllm-edit-history-list {
  background: rgba(15,17,27,0.97);
  border: 1px solid rgba(99,102,241,0.22);
  border-radius: 8px;
  padding: 6px;
  max-height: 200px;
  overflow-y: auto;
}
.anyllm-edit-history-item {
  padding: 6px 8px;
  border-radius: 5px;
  font-size: 11.5px;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: background 0.12s;
}
.anyllm-edit-history-item:hover { background: rgba(99,102,241,0.1); color: #e2e8f0; }
.anyllm-edit-history-ts {
  font-size: 10px;
  color: #4b5563;
  white-space: nowrap;
  flex-shrink: 0;
}
.anyllm-edit-history-preview {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}
`;
  document.head.appendChild(style);
}

// ── Change listeners ──────────────────────────────────────────────────────────

/** @type {Set<Function>} */
const _listeners = new Set();

function _notify(event, detail) {
  _listeners.forEach(cb => { try { cb(event, detail); } catch(e) {} });
}

function onEditChanged(cb)  { _listeners.add(cb); }
function offEditChanged(cb) { _listeners.delete(cb); }

// ── Storage helpers ───────────────────────────────────────────────────────────

async function _loadRecords(platform, conversationId) {
  return getCollection(platform, conversationId, DATA_TYPES.EDIT);
}

async function _saveRecords(platform, conversationId, records) {
  return setCollection(platform, conversationId, DATA_TYPES.EDIT, records);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Find the deepest text-content container inside a message element.
 * We look for standard markdown/prose wrappers first; fall back to the element itself.
 * @param {Element} el
 * @returns {Element}
 */
function _getContentNode(el) {
  // Common wrappers used by Claude, ChatGPT, Gemini
  return (
    el.querySelector('.markdown-content, .message-content, [class*="prose"], .model-response-text, [class*="content"]')
    || el
  );
}

/**
 * Get the current display text of a message element (strips badge/edit widgets).
 * @param {Element} el
 * @returns {string}
 */
function _getDisplayText(el) {
  const node = _getContentNode(el);
  // Clone to strip injected AnyLLM elements before reading innerText
  const clone = node.cloneNode(true);
  clone.querySelectorAll('.anyllm-edit-badge, .anyllm-edit-overlay, [data-anyllm-injected]').forEach(n => n.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

// ── Badge rendering ───────────────────────────────────────────────────────────

function _fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Inject or update the "[Edited …]" badge after the message content.
 * @param {Element} el
 * @param {object}  record
 * @param {Function} onRevertClick
 * @param {Function} onHistoryClick
 */
function _applyBadge(el, record, onRevertClick, onHistoryClick) {
  // Remove existing badge
  el.querySelector('.anyllm-edit-badge')?.remove();

  const badge = document.createElement('span');
  badge.className = 'anyllm-edit-badge';
  badge.dataset.anyllmInjected = '1';
  badge.setAttribute('title', `Edited ${_fmtDate(record.editedAt)} — click for options`);
  badge.innerHTML = `<span class="anyllm-revert-icon">✎</span> Edited ${_fmtDate(record.editedAt)}`;

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    _showBadgeMenu(badge, record, onRevertClick, onHistoryClick);
  });

  const node = _getContentNode(el);
  node.appendChild(badge);
}

/**
 * Show a tiny dropdown from the badge with Revert + History options.
 */
function _showBadgeMenu(badge, record, onRevertClick, onHistoryClick) {
  // Remove any existing menu
  document.querySelectorAll('.anyllm-badge-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'anyllm-badge-menu';
  menu.dataset.anyllmInjected = '1';
  Object.assign(menu.style, {
    position:   'absolute',
    zIndex:     '2147483632',
    background: 'rgba(15,17,27,0.97)',
    border:     '1px solid rgba(99,102,241,0.25)',
    borderRadius: '8px',
    padding:    '4px',
    minWidth:   '160px',
    boxShadow:  '0 8px 24px rgba(0,0,0,0.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  });

  const items = [
    { icon: '↩', label: 'Revert to original', action: onRevertClick },
    { icon: '📋', label: 'Copy current text',  action: () => navigator.clipboard.writeText(record.editedText) },
    { icon: '🕓', label: 'Edit history',        action: onHistoryClick },
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      width: '100%', background: 'none', border: 'none', cursor: 'pointer',
      padding: '6px 10px', borderRadius: '5px', fontSize: '12px',
      color: '#94a3b8', textAlign: 'left', transition: 'background 0.12s',
    });
    btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(99,102,241,0.12)'; btn.style.color = '#e2e8f0'; });
    btn.addEventListener('mouseout',  () => { btn.style.background = 'none'; btn.style.color = '#94a3b8'; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); item.action(); });
    menu.appendChild(btn);
  }

  // Position near badge
  const bRect = badge.getBoundingClientRect();
  menu.style.top  = `${bRect.bottom + 4 + window.scrollY}px`;
  menu.style.left = `${bRect.left + window.scrollX}px`;
  document.body.appendChild(menu);

  // Close on outside click
  const onOutside = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', onOutside); }
  };
  setTimeout(() => document.addEventListener('click', onOutside), 0);
}

// ── Inline editor widget ──────────────────────────────────────────────────────

/**
 * Show the inline textarea editor over the message's content node.
 *
 * @param {Element}  el           — the full message element
 * @param {string}   messageId
 * @param {string}   platform
 * @param {string}   conversationId
 * @param {string}   initialText  — pre-filled text (edited or original)
 * @param {string|null} originalText — null if not yet edited (first edit)
 * @param {object[]} history      — existing edit history array
 * @param {Function} onSave       — (newText: string) => void
 * @param {Function} onCancel     — () => void
 */
function _showEditor(el, messageId, platform, conversationId, initialText, originalText, history, onSave, onCancel) {
  ensureStyles();

  // If an editor is already open on this element, skip
  if (el.querySelector('.anyllm-edit-overlay')) return;

  el.classList.add(EDITING_CLASS);

  const node    = _getContentNode(el);
  const overlay = document.createElement('div');
  overlay.className         = 'anyllm-edit-overlay';
  overlay.dataset.anyllmInjected = '1';

  const textarea = document.createElement('textarea');
  textarea.className = 'anyllm-edit-textarea';
  textarea.value     = initialText;
  textarea.setAttribute('aria-label', 'Edit message text');
  textarea.setAttribute('spellcheck', 'true');

  const charCount = document.createElement('span');
  charCount.className = 'anyllm-edit-charcount';
  charCount.textContent = `${initialText.length} chars`;
  textarea.addEventListener('input', () => {
    charCount.textContent = `${textarea.value.length} chars`;
  });

  // Toolbar row
  const toolbarRow = document.createElement('div');
  toolbarRow.className = 'anyllm-edit-toolbar';

  const saveBtn   = _makeEditBtn('✓ Save', 'save');
  const cancelBtn = _makeEditBtn('✕ Cancel', 'cancel');

  saveBtn.addEventListener('click', () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    _destroyEditor(el, overlay);
    onSave(newText);
  });

  cancelBtn.addEventListener('click', () => {
    _destroyEditor(el, overlay);
    onCancel();
  });

  // Keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
    if (e.key === 'Escape') {
      cancelBtn.click();
    }
  });

  // History button (only if there are prior saves)
  if (history && history.length > 0) {
    const histBtn = document.createElement('button');
    histBtn.className   = 'anyllm-edit-history-btn';
    histBtn.textContent = `🕓 History (${history.length})`;
    histBtn.addEventListener('click', () => _showHistoryDropdown(histBtn, history, (text) => {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input'));
    }));
    toolbarRow.append(saveBtn, cancelBtn, histBtn, charCount);
  } else {
    toolbarRow.append(saveBtn, cancelBtn, charCount);
  }

  // Revert button (only if there's an existing edit to revert)
  if (originalText !== null) {
    const revertBtn = _makeEditBtn('↩ Revert to Original', 'revert');
    revertBtn.addEventListener('click', () => {
      _destroyEditor(el, overlay);
      onSave('__REVERT__'); // sentinel handled in saveEdit
    });
    toolbarRow.appendChild(revertBtn);
  }

  overlay.append(textarea, toolbarRow);
  node.prepend(overlay); // show editor above existing content

  // Auto-focus and select-all
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.select();
  });
}

function _makeEditBtn(label, variant) {
  const btn = document.createElement('button');
  btn.className = `anyllm-edit-btn ${variant}`;
  btn.textContent = label;
  return btn;
}

function _destroyEditor(el, overlay) {
  overlay?.remove();
  el.classList.remove(EDITING_CLASS);
}

/**
 * Show a history version picker dropdown.
 * @param {Element}   anchor
 * @param {object[]}  history
 * @param {Function}  onSelect   — (text: string) => void
 */
function _showHistoryDropdown(anchor, history, onSelect) {
  document.querySelectorAll('.anyllm-edit-history-list').forEach(l => l.remove());

  const list = document.createElement('div');
  list.className = 'anyllm-edit-history-list';
  list.dataset.anyllmInjected = '1';
  Object.assign(list.style, {
    position:   'absolute',
    zIndex:     '2147483631',
  });

  [...history].reverse().forEach(entry => {
    const item = document.createElement('div');
    item.className = 'anyllm-edit-history-item';
    item.innerHTML = `
      <span class="anyllm-edit-history-ts">${_fmtDate(entry.savedAt)}</span>
      <span class="anyllm-edit-history-preview">${entry.text.slice(0, 80).replace(/</g, '&lt;')}</span>
    `;
    item.addEventListener('click', () => { list.remove(); onSelect(entry.text); });
    list.appendChild(item);
  });

  const aRect = anchor.getBoundingClientRect();
  list.style.top  = `${aRect.bottom + 4 + window.scrollY}px`;
  list.style.left = `${aRect.left  + window.scrollX}px`;
  document.body.appendChild(list);

  const onOutside = (e) => {
    if (!list.contains(e.target)) { list.remove(); document.removeEventListener('click', onOutside); }
  };
  setTimeout(() => document.addEventListener('click', onOutside), 0);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Save (or update) a local edit for a message.
 * If `newText === '__REVERT__'`, the edit record is deleted and the original is restored.
 *
 * @param {string} messageId
 * @param {string} newText
 * @param {string} originalText   — the raw text at the time of first edit
 * @param {string} platform
 * @param {string} conversationId
 * @param {Element} el            — the message DOM element (for live update)
 * @returns {Promise<object | null>}  — the saved Edit record, or null if reverted
 */
async function saveEdit(messageId, newText, originalText, platform, conversationId, el) {
  const records = await _loadRecords(platform, conversationId);
  const idx     = records.findIndex(r => r.messageId === messageId);

  // ── Revert sentinel ───────────────────────────────────────────────────────
  if (newText === '__REVERT__') {
    if (idx !== -1) {
      const record = records[idx];
      records.splice(idx, 1);
      await _saveRecords(platform, conversationId, records);
      // Restore DOM
      if (el) {
        const node = _getContentNode(el);
        node.querySelector('.anyllm-edit-badge')?.remove();
        el.classList.remove(EDITED_CLASS);
        // Replace content with original (plain-text; markdown won't re-render)
        const existingContent = node.querySelector('[data-anyllm-edited-text]');
        if (existingContent) {
          existingContent.removeAttribute('data-anyllm-edited-text');
          existingContent.textContent = record.originalText;
        }
      }
      _notify('reverted', { messageId, platform, conversationId });
    }
    return null;
  }

  // ── New or update ─────────────────────────────────────────────────────────
  const now = Date.now();

  if (idx !== -1) {
    // Update existing record
    const record    = records[idx];
    const histEntry = { text: record.editedText, savedAt: record.editedAt };
    const history   = record.history || [];
    history.push(histEntry);
    if (history.length > MAX_HISTORY) history.shift();

    records[idx] = { ...record, editedText: newText, editedAt: now, history };
    await _saveRecords(platform, conversationId, records);
    _applyEditToDOM(el, records[idx]);
    _notify('updated', { record: records[idx] });
    return records[idx];
  } else {
    // First edit — create new record
    const record = createEdit({
      platform, conversationId, messageId,
      originalText, editedText: newText,
    });
    record.history = [];
    records.push(record);
    await _saveRecords(platform, conversationId, records);
    _applyEditToDOM(el, record);
    _notify('created', { record });
    return record;
  }
}

/**
 * Revert a message to its original text (removes storage record, restores DOM).
 * @param {string}  messageId
 * @param {string}  platform
 * @param {string}  conversationId
 * @param {Element} [el]
 * @returns {Promise<boolean>}
 */
async function revertEdit(messageId, platform, conversationId, el) {
  return !!(await saveEdit(messageId, '__REVERT__', null, platform, conversationId, el));
}

/**
 * Load the Edit record for a message, or null if none.
 * @returns {Promise<object | null>}
 */
async function getEdit(messageId, platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  return records.find(r => r.messageId === messageId) || null;
}

/**
 * Check whether a message has a stored local edit.
 * @returns {Promise<boolean>}
 */
async function hasEdit(messageId, platform, conversationId) {
  return !!(await getEdit(messageId, platform, conversationId));
}

// ── DOM application ───────────────────────────────────────────────────────────

/**
 * Apply the stored edited text to a message DOM element.
 * - Replaces the visible text content
 * - Stamps `.anyllm-edited-msg` class
 * - Injects the "[Edited …]" badge
 *
 * @param {Element} el
 * @param {object}  record
 */
function _applyEditToDOM(el, record) {
  if (!el) return;
  ensureStyles();

  el.classList.add(EDITED_CLASS);

  const node = _getContentNode(el);

  // Find or create a text container we control
  let textNode = node.querySelector('[data-anyllm-edited-text]');
  if (!textNode) {
    // Wrap existing content in a span we can replace
    textNode = document.createElement('div');
    textNode.dataset.anyllmEditedText = '1';
    // Move current child nodes into the wrapper
    while (node.firstChild && node.firstChild !== textNode) {
      textNode.appendChild(node.firstChild);
    }
    node.insertBefore(textNode, node.firstChild);
  }
  // Replace text (plain-text; safe against XSS)
  textNode.textContent = record.editedText;

  // Badge
  _applyBadge(
    el,
    record,
    () => {
      // Revert
      revertEdit(record.messageId, record.platform, record.conversationId, el)
        .then(() => console.log(`[AnyLLM][EditService] Reverted ${record.messageId}`));
    },
    () => {
      // Show history
      const badge = el.querySelector('.anyllm-edit-badge');
      if (badge && record.history?.length) {
        _showHistoryDropdown(badge, record.history, (text) => {
          // Restore selected history version into editor
          openEditor(el, record.messageId, record.platform, record.conversationId);
        });
      }
    }
  );
}

/**
 * Re-apply all stored edits for a conversation after a page load.
 * Must be called after the MutationObserver has stamped `data-anyllm-msg-id` attributes.
 *
 * @param {import('../adapters/adapter.js').PlatformAdapter} adapterRef
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<number>}  — count of edits re-applied
 */
async function applyEditsToDOM(adapterRef, platform, conversationId) {
  ensureStyles();

  const records = await _loadRecords(platform, conversationId);
  if (records.length === 0) return 0;

  const idMap   = new Map(records.map(r => [r.messageId, r]));
  const elements = adapterRef.getMessageElements();
  let count = 0;

  elements.forEach((el, idx) => {
    const data = adapterRef.extractMessageData(el, idx);
    if (!data) return;
    const record = idMap.get(data.messageId);
    if (record) {
      _applyEditToDOM(el, record);
      count++;
    }
  });

  console.log(`[AnyLLM][EditService] Re-applied ${count} edit(s) after page load`);
  return count;
}

// ── Open editor (called from toolbar action) ──────────────────────────────────

/**
 * Open the inline editor for a message element.
 * Fetches the existing edit (if any) and passes state into the editor widget.
 *
 * @param {Element} el
 * @param {string}  messageId
 * @param {string}  platform
 * @param {string}  conversationId
 */
async function openEditor(el, messageId, platform, conversationId) {
  ensureStyles();

  const existingRecord = await getEdit(messageId, platform, conversationId);
  const originalText   = existingRecord
    ? existingRecord.originalText
    : _getDisplayText(el);
  const currentText    = existingRecord ? existingRecord.editedText : originalText;
  const history        = existingRecord?.history || [];

  _showEditor(
    el, messageId, platform, conversationId,
    currentText,
    existingRecord ? originalText : null, // null = no prior edit → no revert btn
    history,
    async (newText) => {
      await saveEdit(messageId, newText, originalText, platform, conversationId, el);
      console.log(`[AnyLLM][EditService] Saved edit for ${messageId}`);
    },
    () => {
      console.log(`[AnyLLM][EditService] Edit cancelled for ${messageId}`);
    }
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

const EditService = Object.freeze({
  saveEdit,
  revertEdit,
  getEdit,
  hasEdit,
  openEditor,
  applyEditsToDOM,
  onEditChanged,
  offEditChanged,
  EDITED_CLASS,
});

export default EditService;
export {
  saveEdit,
  revertEdit,
  getEdit,
  hasEdit,
  openEditor,
  applyEditsToDOM,
  onEditChanged,
  offEditChanged,
};
