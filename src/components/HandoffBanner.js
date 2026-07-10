// src/components/HandoffBanner.js
// AnyLLM — Token Limit Handoff Banner (P2.7)
//
// A floating banner injected at the top of the chat window when the token limit
// is approaching/reached. Provides 1-click delivery options for the Handoff Prompt.

'use strict';

import HandoffService from '../services/handoffService.js';

const BANNER_ID = 'anyllm-handoff-banner';
const STYLE_ID  = 'anyllm-handoff-banner-styles';

let _adapterRef = null;
let _platform = null;
let _conversationId = null;

function buildStyles() {
  return `
    #${BANNER_ID} {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(-100%);
      z-index: 2147483645;
      background: linear-gradient(135deg, rgba(30, 27, 75, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%);
      border: 1px solid rgba(139, 92, 246, 0.4);
      border-radius: 12px;
      padding: 16px 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5), 0 0 15px rgba(139, 92, 246, 0.2);
      color: #e2e8f0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 320px;
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
      backdrop-filter: blur(8px);
    }
    #${BANNER_ID}.anyllm-banner-visible {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
    .anyllm-banner-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      color: #c4b5fd;
    }
    .anyllm-banner-close {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 16px;
    }
    .anyllm-banner-close:hover { color: #fff; }
    .anyllm-banner-text {
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.4;
    }
    .anyllm-banner-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .anyllm-banner-btn {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: #f1f5f9;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .anyllm-banner-btn:hover { background: rgba(255,255,255,0.15); border-color: rgba(255,255,255,0.25); }
    .anyllm-banner-btn.primary {
      background: rgba(139, 92, 246, 0.2);
      border-color: rgba(139, 92, 246, 0.5);
      color: #e0e7ff;
    }
    .anyllm-banner-btn.primary:hover {
      background: rgba(139, 92, 246, 0.4);
    }
  `;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildStyles();
  document.head.appendChild(style);
}

function showBanner() {
  ensureStyles();
  let banner = document.getElementById(BANNER_ID);
  if (banner) {
    banner.classList.add('anyllm-banner-visible');
    return;
  }

  banner = document.createElement('div');
  banner.id = BANNER_ID;

  const header = document.createElement('div');
  header.className = 'anyllm-banner-header';
  header.innerHTML = `<span>⚠️ Token Limit Detected</span>`;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'anyllm-banner-close';
  closeBtn.innerHTML = '✕';
  closeBtn.onclick = hideBanner;
  header.appendChild(closeBtn);

  const text = document.createElement('div');
  text.className = 'anyllm-banner-text';
  text.innerHTML = 'You are approaching the context length limit. Would you like to extract the context and handoff to another platform?';

  const actions = document.createElement('div');
  actions.className = 'anyllm-banner-actions';

  const copyBtn = _createBtn('📋 Copy Context', async (btn) => {
    btn.innerHTML = '⏳ Extracting...';
    const prompt = HandoffService.generateHandoffPrompt(_adapterRef);
    await HandoffService.deliverToClipboard(prompt);
    btn.innerHTML = '✓ Copied';
    setTimeout(() => btn.innerHTML = '📋 Copy Context', 2000);
  });

  const pinBtn = _createBtn('📌 Pin Context', async (btn) => {
    btn.innerHTML = '⏳ Extracting...';
    const prompt = HandoffService.generateHandoffPrompt(_adapterRef);
    await HandoffService.deliverToPinboard(prompt, _platform, _conversationId);
    btn.innerHTML = '✓ Pinned';
    setTimeout(() => btn.innerHTML = '📌 Pin Context', 2000);
  });

  const targetPlatforms = ['chatgpt', 'claude', 'gemini'].filter(p => p !== _platform);
  
  actions.append(copyBtn, pinBtn);

  for (const t of targetPlatforms) {
    const name = t.charAt(0).toUpperCase() + t.slice(1);
    const btn = _createBtn(`🚀 Send to ${name}`, async (b) => {
      b.innerHTML = '⏳ Extracting...';
      const prompt = HandoffService.generateHandoffPrompt(_adapterRef);
      HandoffService.deliverToNewTab(t, prompt);
      b.innerHTML = '✓ Sent';
      setTimeout(() => hideBanner(), 1000);
    });
    btn.classList.add('primary');
    actions.appendChild(btn);
  }

  banner.append(header, text, actions);
  document.body.appendChild(banner);

  // Trigger animation
  requestAnimationFrame(() => {
    banner.classList.add('anyllm-banner-visible');
  });
}

function _createBtn(label, onClickAsync) {
  const btn = document.createElement('button');
  btn.className = 'anyllm-banner-btn';
  btn.innerHTML = label;
  btn.onclick = () => onClickAsync(btn);
  return btn;
}

function hideBanner() {
  const banner = document.getElementById(BANNER_ID);
  if (banner) {
    banner.classList.remove('anyllm-banner-visible');
  }
}

function init(adapterRef, platform, conversationId) {
  _adapterRef = adapterRef;
  _platform = platform;
  _conversationId = conversationId;
}

const HandoffBanner = { init, showBanner, hideBanner };
export default HandoffBanner;
