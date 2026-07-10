// src/background.js
// Service Worker for AnyLLM Extension
//
// Handles:
//   - Extension install / update lifecycle
//   - Message routing between content scripts and popup
//   - ANYLLM_OPEN_URL: opens a new tab (used by ContextSidePanel handoff buttons)

'use strict';

console.log('[AnyLLM] Background service worker started.');

// ── Extension lifecycle ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[AnyLLM] Extension installed or updated:', details.reason);

  chrome.storage.local.set({
    'anyllm-initialized': true,
    'anyllm-version': '1.1.0',
  }, () => {
    console.log('[AnyLLM] Default settings initialized.');
  });
});

// ── Message routing ───────────────────────────────────────────────────────────
//
// Known message types (grow with each phase):
//   ANYLLM_EXTRACT_CONTEXT  — popup → content script (forwarded directly via tabs.sendMessage)
//   ANYLLM_TOGGLE_PANEL     — popup → content script
//   ANYLLM_OPEN_URL         — content script → background (open a new tab)

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const type = request?.type;
  console.log('[AnyLLM] Background received message:', type, request);

  // ── Open a URL in a new tab (used by panel's "Open Claude / ChatGPT / Gemini" buttons)
  if (type === 'ANYLLM_OPEN_URL') {
    const url = request.url;
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid URL' });
      return false;
    }
    chrome.tabs.create({ url }, (tab) => {
      sendResponse({ success: true, tabId: tab?.id });
    });
    return true; // keep channel open for async
  }

  // ── P2.7 — Deliver handoff prompt to a new tab
  if (type === 'ANYLLM_DELIVER_HANDOFF_NEW_TAB') {
    const PLATFORM_URLS = {
      chatgpt: 'https://chatgpt.com/',
      claude:  'https://claude.ai/new',
      gemini:  'https://gemini.google.com/app'
    };
    const url = PLATFORM_URLS[request.targetPlatform];
    if (!url) {
      sendResponse({ success: false });
      return false;
    }

    // Save pending handoff prompt
    chrome.storage.local.set({ anyllm_pending_handoff: request.prompt }, () => {
      chrome.tabs.create({ url }, (tab) => {
        sendResponse({ success: true, tabId: tab?.id });
      });
    });
    return true;
  }

  // ── Default: echo back for debugging
  sendResponse({ status: 'Background received message', type });
  return true;
});

// ── Tab update tracking ───────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log('[AnyLLM] Tab updated:', tab.url);
  }
});

