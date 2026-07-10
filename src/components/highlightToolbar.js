// src/components/highlightToolbar.js
// AnyLLM — Highlight Selection Toolbar (P2.6)
//
// Shows a floating toolbar with colour swatches when text is selected within
// a message container. Clicking a swatch saves the highlight via HighlightService.

'use strict';

import HighlightService from '../services/highlightService.js';

const TOOLBAR_ID = 'anyllm-highlight-toolbar';

let _adapterRef = null;
let _platform = null;
let _conversationId = null;

function ensureStyles() {
  if (document.getElementById(TOOLBAR_ID + '-styles')) return;
  const style = document.createElement('style');
  style.id = TOOLBAR_ID + '-styles';
  style.textContent = `
    #${TOOLBAR_ID} {
      position: absolute;
      z-index: 2147483640;
      display: none;
      background: rgba(15, 17, 27, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      padding: 4px 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      gap: 6px;
      align-items: center;
      transition: opacity 0.15s ease, transform 0.15s ease;
      transform: translateY(5px);
      opacity: 0;
    }
    #${TOOLBAR_ID}.anyllm-visible {
      display: flex;
      transform: translateY(0);
      opacity: 1;
    }
    .anyllm-swatch {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      transition: transform 0.1s ease, border-color 0.1s ease;
    }
    .anyllm-swatch:hover {
      transform: scale(1.15);
      border-color: rgba(255, 255, 255, 0.6);
    }
    .anyllm-swatch[data-color="yellow"] { background-color: #facc15; }
    .anyllm-swatch[data-color="green"]  { background-color: #4ade80; }
    .anyllm-swatch[data-color="red"]    { background-color: #f87171; }
  `;
  document.head.appendChild(style);
}

function createToolbar() {
  ensureStyles();
  let toolbar = document.getElementById(TOOLBAR_ID);
  if (toolbar) return toolbar;

  toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  
  const colors = ['yellow', 'green', 'red'];
  for (const c of colors) {
    const swatch = document.createElement('div');
    swatch.className = 'anyllm-swatch';
    swatch.dataset.color = c;
    swatch.title = `Highlight ${c}`;
    
    // Use mousedown and preventDefault to stop the browser from clearing the selection
    swatch.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleSwatchClick(c);
      hideToolbar();
    });
    
    toolbar.appendChild(swatch);
  }

  document.body.appendChild(toolbar);
  return toolbar;
}

let activeSelectionRange = null;
let activeMessageRoot = null;
let activeMessageId = null;

async function handleSwatchClick(color) {
  if (!activeSelectionRange || !activeMessageRoot || !activeMessageId) return;

  // Restore selection if browser cleared it
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(activeSelectionRange);

  await HighlightService.saveHighlight(
    sel, color, activeMessageId, _platform, _conversationId, activeMessageRoot
  );
  
  sel.removeAllRanges(); // clear selection after highlight
}

function hideToolbar() {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (toolbar) {
    toolbar.classList.remove('anyllm-visible');
    // Short delay before setting display: none to allow CSS transition
    setTimeout(() => {
      if (!toolbar.classList.contains('anyllm-visible')) {
        toolbar.style.display = 'none';
      }
    }, 150);
  }
}

function showToolbar(rect) {
  const toolbar = createToolbar();
  toolbar.style.display = 'flex';
  
  // Position above selection
  const top = rect.top + window.scrollY - 35;
  const left = rect.left + window.scrollX + (rect.width / 2) - (toolbar.offsetWidth / 2);
  
  toolbar.style.top = `${top}px`;
  // Ensure it doesn't go off screen horizontally
  toolbar.style.left = `${Math.max(10, left)}px`;

  // Trigger reflow
  toolbar.offsetHeight; 
  toolbar.classList.add('anyllm-visible');
}

/**
 * Handle mouseup on document to check for valid text selection.
 */
function onMouseUp(e) {
  // If clicking inside toolbar, ignore
  if (e.target.closest(`#${TOOLBAR_ID}`)) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    hideToolbar();
    return;
  }

  const range = sel.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) {
    hideToolbar();
    return;
  }

  // Check if selection is inside a tracked message container
  let msgRoot = range.commonAncestorContainer;
  if (msgRoot.nodeType === Node.TEXT_NODE) msgRoot = msgRoot.parentNode;
  
  const container = msgRoot.closest('[data-anyllm-msg-id]');
  if (!container) {
    hideToolbar();
    return;
  }

  // Found a valid selection
  activeSelectionRange = range.cloneRange();
  activeMessageRoot = container;
  activeMessageId = container.getAttribute('data-anyllm-msg-id');

  const rect = range.getBoundingClientRect();
  showToolbar(rect);
}

/**
 * Initialise the selection listener for highlights.
 * @param {import('../adapters/adapter.js').PlatformAdapter} adapterRef 
 * @param {string} platform 
 * @param {string} conversationId 
 */
function init(adapterRef, platform, conversationId) {
  _adapterRef = adapterRef;
  _platform = platform;
  _conversationId = conversationId;

  document.addEventListener('mouseup', onMouseUp);
  
  // Hide on scroll or mousedown elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest(`#${TOOLBAR_ID}`)) {
      hideToolbar();
    }
  });
}

function destroy() {
  document.removeEventListener('mouseup', onMouseUp);
  const t = document.getElementById(TOOLBAR_ID);
  if (t) t.remove();
}

const HighlightToolbar = {
  init,
  destroy
};

export default HighlightToolbar;
