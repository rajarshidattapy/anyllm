// src/services/handoffService.js
// AnyLLM — Context Handoff Service (P2.7)
//
// Extracts context from the current conversation and provides delivery methods:
// 1. Copy to Clipboard
// 2. Save to Pinboard
// 3. Send to New Tab (cross-platform injection)

'use strict';

import { extractContext } from './contextExtractor.js';
import { pinMessage } from './pinService.js';

/**
 * Generate the structured handoff prompt.
 * @param {import('../adapters/adapter.js').PlatformAdapter} adapterRef
 * @returns {string} The formatted prompt template
 */
export function generateHandoffPrompt(adapterRef) {
  const context = extractContext(adapterRef);
  return context.handoffPrompt;
}

/**
 * Deliver to clipboard.
 * @param {string} prompt 
 * @returns {Promise<boolean>}
 */
export async function deliverToClipboard(prompt) {
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch (e) {
    console.error('[AnyLLM][HandoffService] Failed to write clipboard:', e);
    return false;
  }
}

/**
 * Deliver as a pin to the current conversation's pinboard.
 * @param {string} prompt 
 * @param {string} platform 
 * @param {string} conversationId 
 */
export async function deliverToPinboard(prompt, platform, conversationId) {
  await pinMessage({
    platform,
    conversationId,
    messageId: 'handoff-' + Date.now(),
    role: 'user',
    text: prompt
  });
}

/**
 * Open a new tab for the target platform and inject the prompt.
 * @param {string} targetPlatform ('chatgpt' | 'claude' | 'gemini')
 * @param {string} prompt
 */
export function deliverToNewTab(targetPlatform, prompt) {
  chrome.runtime.sendMessage({
    type: 'ANYLLM_DELIVER_HANDOFF_NEW_TAB',
    targetPlatform,
    prompt
  });
}

export default {
  generateHandoffPrompt,
  deliverToClipboard,
  deliverToPinboard,
  deliverToNewTab
};
