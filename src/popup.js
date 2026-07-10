// src/popup.js
// AnyLLM — Popup Script
//
// Handles the extension popup UI:
//   - Platform detection from the active tab URL
//   - "Extract Context" button → sends ANYLLM_EXTRACT_CONTEXT to content script
//   - "Pinboard" and "Context Handoff" buttons (scaffolded for P2.3 / P2.7)

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[AnyLLM] Popup script loaded.');

  // ── Elements ─────────────────────────────────────────────────────────────

  const platformIndicator    = document.querySelector('.platform-indicator');
  const statusText           = document.querySelector('.status-text');
  const extractBtn           = document.getElementById('btn-extract');
  const pinboardBtn          = document.getElementById('btn-pinboard');
  const highlightsBtn        = document.getElementById('btn-highlights');
  const handoffBtn           = document.getElementById('btn-handoff');
  const toggleDeletedBtn     = document.getElementById('btn-toggle-deleted');
  const toggleDeletedLabel   = document.getElementById('btn-toggle-deleted-label');
  const bulkDeleteBtn        = document.getElementById('btn-bulk-delete');

  // ── Platform detection ────────────────────────────────────────────────────

  let activeTabId = null;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;

    const tab = tabs[0];
    activeTabId = tab.id;

    let url;
    try {
      url = new URL(tab.url);
    } catch (_) {
      setUnsupported();
      return;
    }

    const hostname = url.hostname;

    if (hostname.includes('claude.ai')) {
      setSupported('Claude.ai', '#7c3aed');
    } else if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) {
      setSupported('ChatGPT', '#10a37f');
    } else if (hostname.includes('gemini.google.com')) {
      setSupported('Google Gemini', '#4285f4');
    } else {
      setUnsupported();
    }
  });

  function setSupported(platformName, accentColor) {
    platformIndicator.textContent = `Platform: ${platformName}`;
    platformIndicator.style.color = accentColor;
    statusText.textContent = 'AnyLLM Ready ✓';
    enableButtons();
  }

  function setUnsupported() {
    platformIndicator.textContent = 'Platform: Unsupported';
    platformIndicator.style.color = '#ef4444';
    statusText.textContent = 'Open Claude, ChatGPT or Gemini to get started.';
    statusText.style.color = '#94a3b8';
  }

  function enableButtons() {
    [extractBtn, pinboardBtn, highlightsBtn, handoffBtn, toggleDeletedBtn, bulkDeleteBtn].forEach(btn => {
      btn.disabled = false;
    });
  }

  // ── Button handlers ───────────────────────────────────────────────────────

  extractBtn.addEventListener('click', () => {
    if (activeTabId === null) return;

    extractBtn.disabled = true;
    extractBtn.querySelector('span').textContent = 'Extracting…';

    chrome.tabs.sendMessage(
      activeTabId,
      { type: 'ANYLLM_EXTRACT_CONTEXT' },
      (response) => {
        extractBtn.disabled = false;
        extractBtn.querySelector('span').textContent = 'Extract Context';

        if (chrome.runtime.lastError) {
          console.warn('[AnyLLM] Popup: sendMessage error:', chrome.runtime.lastError.message);
          showError('Could not reach content script. Reload the page and try again.');
          return;
        }

        if (response?.success) {
          // Panel is now open on the page — close the popup
          window.close();
        } else {
          showError(response?.error || 'Unknown error during extraction.');
        }
      }
    );
  });

  pinboardBtn.addEventListener('click', () => {
    if (activeTabId === null) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'ANYLLM_OPEN_PINBOARD' });
    window.close();
  });

  highlightsBtn.addEventListener('click', () => {
    if (activeTabId === null) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'ANYLLM_OPEN_HIGHLIGHTS' });
    window.close();
  });

  handoffBtn.addEventListener('click', () => {
    if (activeTabId === null) return;
    // Toggle the panel on the page (useful when panel is already rendered)
    chrome.tabs.sendMessage(activeTabId, { type: 'ANYLLM_TOGGLE_PANEL' });
    window.close();
  });

  // ── P2.4 — Show / Hide deleted messages ──────────────────────────────────
  let _showingDeleted = false;

  toggleDeletedBtn.addEventListener('click', () => {
    if (activeTabId === null) return;
    chrome.tabs.sendMessage(
      activeTabId,
      { type: 'ANYLLM_TOGGLE_DELETED' },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) return;
        _showingDeleted = response.visible;
        if (toggleDeletedLabel) {
          toggleDeletedLabel.textContent = _showingDeleted
            ? '🙈 Hide Deleted'
            : '👁 Show Deleted';
        }
        toggleDeletedBtn.classList.toggle('active-state', _showingDeleted);
        // Don't close popup so user can toggle back easily
      }
    );
  });

  // ── P2.4 — Bulk delete mode ───────────────────────────────────────────────
  let _bulkModeOn = false;

  bulkDeleteBtn.addEventListener('click', () => {
    if (activeTabId === null) return;
    chrome.tabs.sendMessage(
      activeTabId,
      { type: 'ANYLLM_BULK_DELETE_MODE' },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) return;
        _bulkModeOn = response.mode === 'on';
        bulkDeleteBtn.querySelector('span').textContent = _bulkModeOn
          ? '✕ Exit Bulk Mode'
          : '🗑 Bulk Delete';
        bulkDeleteBtn.classList.toggle('active-state', _bulkModeOn);
        if (_bulkModeOn) window.close(); // Close popup so user can click checkboxes
      }
    );
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showError(msg) {
    const existing = document.getElementById('anyllm-popup-error');
    if (existing) existing.remove();

    const err = document.createElement('p');
    err.id = 'anyllm-popup-error';
    err.style.cssText = [
      'color:#ef4444', 'font-size:11px', 'margin-top:8px',
      'padding:6px 10px', 'background:rgba(239,68,68,0.1)',
      'border:1px solid rgba(239,68,68,0.25)', 'border-radius:6px',
    ].join(';');
    err.textContent = msg;
    document.querySelector('.popup-content').appendChild(err);

    setTimeout(() => err.remove(), 5000);
  }
});
