// src/services/highlightService.js
// AnyLLM — Highlight Service (P2.6)
//
// Allows users to select text within messages and highlight it in three colours:
// Yellow, Green, Red.
//
// Highlights persist across page reloads by storing an XPath relative to the
// message container, along with the text content for verification.

'use strict';

import { DATA_TYPES, getCollection, setCollection, createHighlight } from './storage.js';

const STYLE_ID = 'anyllm-highlight-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .anyllm-highlight {
      position: relative;
      border-radius: 3px;
      padding: 0 2px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .anyllm-highlight:hover {
      opacity: 0.8;
    }
    .anyllm-highlight-yellow { background-color: rgba(250, 204, 21, 0.4); border-bottom: 2px solid rgba(250, 204, 21, 0.8); }
    .anyllm-highlight-green  { background-color: rgba(74, 222, 128, 0.4); border-bottom: 2px solid rgba(74, 222, 128, 0.8); }
    .anyllm-highlight-red    { background-color: rgba(248, 113, 113, 0.4); border-bottom: 2px solid rgba(248, 113, 113, 0.8); }
  `;
  document.head.appendChild(style);
}

/** @type {Set<Function>} */
const _listeners = new Set();
function _notify(event, detail) { _listeners.forEach(cb => { try { cb(event, detail); } catch (e) {} }); }
function onHighlightChanged(cb) { _listeners.add(cb); }
function offHighlightChanged(cb) { _listeners.delete(cb); }

async function _loadRecords(platform, conversationId) {
  return getCollection(platform, conversationId, DATA_TYPES.HIGHLIGHT);
}

async function _saveRecords(platform, conversationId, records) {
  return setCollection(platform, conversationId, DATA_TYPES.HIGHLIGHT, records);
}

// ── DOM Pathing (Relative to message root) ────────────────────────────────────

/**
 * Get an XPath string for a node, relative to a given root element.
 * @param {Node} node 
 * @param {Element} root 
 * @returns {string}
 */
function _getRelativeXPath(node, root) {
  if (node === root) return '';
  if (!node || !node.parentNode) return '';

  let idx = 1;
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.nodeType === node.nodeType && sibling.nodeName === node.nodeName) {
      idx++;
    }
    sibling = sibling.previousSibling;
  }

  const nodeName = node.nodeType === Node.TEXT_NODE ? 'text()' : node.nodeName.toLowerCase();
  const pathIndex = `[${idx}]`;
  const step = nodeName + pathIndex;

  if (node.parentNode === root) {
    return step;
  }
  return _getRelativeXPath(node.parentNode, root) + '/' + step;
}

/**
 * Resolve an XPath string relative to a root element.
 * @param {string} path 
 * @param {Element} root 
 * @returns {Node|null}
 */
function _resolveRelativeXPath(path, root) {
  if (!path) return root;
  try {
    const evaluator = new XPathEvaluator();
    // Prefix with dot to make it relative to the root node context
    const result = evaluator.evaluate('.' + (path.startsWith('/') ? '' : '/') + path, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue;
  } catch (e) {
    console.error('[AnyLLM][HighlightService] Failed to resolve XPath:', path, e);
    return null;
  }
}

// ── Highlight Application ─────────────────────────────────────────────────────

/**
 * Add a highlight span in the DOM.
 * @param {Range} range 
 * @param {object} record 
 * @returns {Element} The wrapper span
 */
function _applyHighlightDOM(range, record) {
  ensureStyles();
  const span = document.createElement('span');
  span.className = `anyllm-highlight anyllm-highlight-${record.color}`;
  span.dataset.anyllmHighlightId = record.id;
  span.title = 'Click to remove highlight';
  
  // Wrap range contents
  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  } catch (e) {
    console.error('[AnyLLM][HighlightService] Failed to wrap range', e);
    return null;
  }

  span.addEventListener('click', (e) => {
    e.stopPropagation();
    _removeHighlight(record);
  });

  return span;
}

/**
 * Re-apply a saved highlight record to the DOM.
 * @param {Element} msgRoot 
 * @param {object} record 
 */
function _restoreHighlightDOM(msgRoot, record) {
  const startNode = _resolveRelativeXPath(record.startPath, msgRoot);
  const endNode = _resolveRelativeXPath(record.endPath, msgRoot);

  if (!startNode || !endNode) {
    console.warn(`[AnyLLM][HighlightService] Could not resolve nodes for highlight ${record.id}`);
    return false;
  }

  try {
    const range = document.createRange();
    // Safety checks for offsets in case DOM changed slightly
    const startOffset = Math.min(record.startOffset, startNode.textContent?.length || 0);
    const endOffset = Math.min(record.endOffset, endNode.textContent?.length || 0);
    
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    
    // Verify text matches roughly
    const rangeText = range.toString().trim();
    if (rangeText && !record.text.includes(rangeText) && !rangeText.includes(record.text)) {
      console.warn(`[AnyLLM][HighlightService] Text mismatch for highlight ${record.id}. Expected: "${record.text.slice(0, 20)}", Got: "${rangeText.slice(0, 20)}"`);
      // We still apply it, but it might be off
    }

    _applyHighlightDOM(range, record);
    return true;
  } catch (e) {
    console.warn(`[AnyLLM][HighlightService] Failed to restore highlight ${record.id}`, e);
    return false;
  }
}

// ── Core Operations ───────────────────────────────────────────────────────────

async function saveHighlight(selection, color, messageId, platform, conversationId, msgRoot) {
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;

  const startPath = _getRelativeXPath(range.startContainer, msgRoot);
  const endPath = _getRelativeXPath(range.endContainer, msgRoot);
  const text = selection.toString();

  const record = createHighlight({
    platform,
    conversationId,
    messageId,
    text,
    color,
    startPath,
    startOffset: range.startOffset,
    endPath,
    endOffset: range.endOffset
  });

  const records = await _loadRecords(platform, conversationId);
  records.push(record);
  await _saveRecords(platform, conversationId, records);

  _applyHighlightDOM(range, record);
  _notify('created', { record });
  return record;
}

async function removeHighlight(record) {
  // Remove from storage
  const records = await _loadRecords(record.platform, record.conversationId);
  const filtered = records.filter(r => r.id !== record.id);
  await _saveRecords(record.platform, record.conversationId, filtered);

  // Remove from DOM
  const span = document.querySelector(`[data-anyllm-highlight-id="${record.id}"]`);
  if (span) {
    const parent = span.parentNode;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
    parent.normalize(); // Merge adjacent text nodes back
  }

  _notify('removed', { recordId: record.id, platform: record.platform, conversationId: record.conversationId });
}

async function getHighlights(platform, conversationId) {
  return _loadRecords(platform, conversationId);
}

async function clearHighlights(platform, conversationId) {
  const records = await _loadRecords(platform, conversationId);
  for (const r of records) {
    const span = document.querySelector(`[data-anyllm-highlight-id="${r.id}"]`);
    if (span) {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }
  }
  await _saveRecords(platform, conversationId, []);
  _notify('cleared', { platform, conversationId });
}

async function applyHighlightsToDOM(adapterRef, platform, conversationId) {
  ensureStyles();
  const records = await _loadRecords(platform, conversationId);
  if (records.length === 0) return 0;

  let count = 0;
  const elements = adapterRef.getMessageElements();
  const elementsMap = new Map();
  elements.forEach((el, idx) => {
    const data = adapterRef.extractMessageData(el, idx);
    if (data) elementsMap.set(data.messageId, el);
  });

  for (const record of records) {
    const msgRoot = elementsMap.get(record.messageId);
    if (msgRoot) {
      // Avoid duplicating if already injected
      if (!msgRoot.querySelector(`[data-anyllm-highlight-id="${record.id}"]`)) {
        if (_restoreHighlightDOM(msgRoot, record)) count++;
      }
    }
  }

  console.log(`[AnyLLM][HighlightService] Re-applied ${count} highlight(s) after page load`);
  return count;
}

const HighlightService = Object.freeze({
  saveHighlight,
  removeHighlight,
  getHighlights,
  clearHighlights,
  applyHighlightsToDOM,
  onHighlightChanged,
  offHighlightChanged
});

export default HighlightService;
export {
  saveHighlight,
  removeHighlight,
  getHighlights,
  clearHighlights,
  applyHighlightsToDOM,
  onHighlightChanged,
  offHighlightChanged
};
