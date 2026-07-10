// src/adapters/adapter.js
// AnyLLM — Platform Adapters (Claude.ai, ChatGPT, Google Gemini)
//
// A single file covering every supported web platform:
//   1. PlatformAdapter — the interface every adapter implements, plus shared
//      DOM query helpers (_queryFirst, _queryAll, _getText, _deriveMessageId).
//   2. ClaudeAdapter    — claude.ai
//   3. ChatGPTAdapter   — chat.openai.com / chatgpt.com
//   4. GeminiAdapter    — gemini.google.com
//
// Each adapter turns a platform's DOM into the same shape:
//   { messageId, role: 'user'|'assistant'|'unknown', text, element }
// so every downstream service (contextExtractor, pinService, highlightService,
// deleteService, handoffService, …) works identically regardless of platform.

'use strict';

// ════════════════════════════════════════════════════════════════════════════
// PlatformAdapter — base class
// ════════════════════════════════════════════════════════════════════════════
//
// Defines the interface every platform adapter must implement.
// Extend this class — do NOT use it directly.

export class PlatformAdapter {
  /**
   * Return a stable identifier string for this platform.
   * @returns {'claude' | 'chatgpt' | 'gemini' | 'unknown'}
   */
  getPlatformIdentifier() {
    throw new Error('[AnyLLM] getPlatformIdentifier() must be implemented by the adapter.');
  }

  /**
   * Extract the conversation ID from the current page URL.
   * Returns 'unknown' if the URL does not contain one.
   * @returns {string}
   */
  getConversationId() {
    throw new Error('[AnyLLM] getConversationId() must be implemented by the adapter.');
  }

  /**
   * Return the primary scrollable chat container element.
   * Used as the MutationObserver target for optimal performance.
   * @returns {Element | null}
   */
  getChatContainer() {
    throw new Error('[AnyLLM] getChatContainer() must be implemented by the adapter.');
  }

  /**
   * Return all current message turn elements visible in the chat.
   * Each element should represent one full message turn (user or assistant).
   * @returns {Element[]}
   */
  getMessageElements() {
    throw new Error('[AnyLLM] getMessageElements() must be implemented by the adapter.');
  }

  /**
   * Given a message element returned by getMessageElements(), extract
   * its structured data.
   *
   * @param {Element} element
   * @returns {{
   *   messageId: string,
   *   role: 'user' | 'assistant' | 'unknown',
   *   text: string,
   *   element: Element
   * } | null}
   */
  extractMessageData(element) {
    throw new Error('[AnyLLM] extractMessageData() must be implemented by the adapter.');
  }

  /**
   * Return true if the token/context-limit warning is currently visible.
   * @returns {boolean}
   */
  detectTokenLimitWarning() {
    throw new Error('[AnyLLM] detectTokenLimitWarning() must be implemented by the adapter.');
  }

  // ── Shared utility helpers available to all adapters ──────────────────────

  /**
   * Try a list of CSS selectors in order and return the first matching element.
   * Returns null if none match.
   *
   * @protected
   * @param {string[]} selectors
   * @param {Element | Document} [root=document]
   * @returns {Element | null}
   */
  _queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {
        // Invalid selector — skip silently
      }
    }
    return null;
  }

  /**
   * Try a list of CSS selectors in order and return all matching elements
   * from the first selector that yields results.
   *
   * @protected
   * @param {string[]} selectors
   * @param {Element | Document} [root=document]
   * @returns {Element[]}
   */
  _queryAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const els = Array.from(root.querySelectorAll(sel));
        if (els.length > 0) return els;
      } catch (_) {
        // Invalid selector — skip silently
      }
    }
    return [];
  }

  /**
   * Extract the innerText of an element, with graceful fallback.
   *
   * @protected
   * @param {Element | null} el
   * @returns {string}
   */
  _getText(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim();
  }

  /**
   * Generate a stable message ID from an element.
   * Prefers data attributes; falls back to a positional index string.
   *
   * @protected
   * @param {Element} el
   * @param {number} [index]
   * @returns {string}
   */
  _deriveMessageId(el, index = 0) {
    return (
      el.dataset?.messageId ||
      el.dataset?.testid ||
      el.id ||
      el.getAttribute('data-id') ||
      el.getAttribute('data-message-id') ||
      `anyllm-msg-${index}`
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ClaudeAdapter — claude.ai
// ════════════════════════════════════════════════════════════════════════════
//
// Selector strategy (in priority order):
//   1. ARIA roles / semantic HTML  →  most stable across redesigns
//   2. data-testid attributes      →  stable in test-tagged builds
//   3. Known class fragments       →  less stable; used as last resort
//
// Claude.ai is a React SPA. The DOM is fully dynamic; we use MutationObserver
// (managed by content.js) rather than querying once at load time.

const CLAUDE_CHAT_CONTAINER_SELECTORS = [
  // Primary: semantic scrolling region
  '[role="log"]',
  // Fallback: known Claude scroll wrappers
  'main [class*="overflow-y-auto"]',
  'main [class*="scroll"]',
  // Last resort
  'main',
];

const CLAUDE_USER_TURN_SIGNALS = [
  '[data-testid="human-turn"]',
  '[data-testid="user-message"]',
  '[class*="human-turn"]',
  '[class*="HumanMessage"]',
];

const CLAUDE_TOKEN_LIMIT_SELECTORS = [
  '[data-testid="token-limit-banner"]',
  '[class*="ContextLimitBanner"]',
  '[class*="context-limit"]',
  '[class*="limit-reached"]',
];
const CLAUDE_TOKEN_LIMIT_TEXT_PATTERNS = [
  /context (window|limit) (is |has been )?reached/i,
  /conversation (is |has become )?too long/i,
  /maximum (context|token) length/i,
  /starting a new (chat|conversation)/i,
];

export class ClaudeAdapter extends PlatformAdapter {
  constructor() {
    super();
    this._platform = 'claude';
  }

  // ── Interface implementation ───────────────────────────────────────────────

  getPlatformIdentifier() {
    return this._platform;
  }

  getConversationId() {
    // Claude URL format: https://claude.ai/chat/<uuid>
    const match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : 'unknown';
  }

  getChatContainer() {
    const container = this._queryFirst(CLAUDE_CHAT_CONTAINER_SELECTORS);
    if (!container) {
      console.warn('[AnyLLM][ClaudeAdapter] Could not locate chat container.');
    }
    return container;
  }

  getMessageElements() {
    // Try a combined selector first for efficiency
    const combined = '[data-testid^="human-turn"], [data-testid^="ai-turn"], ' +
      '[data-testid="user-message"], [data-testid="assistant-message"]';
    const primary = Array.from(document.querySelectorAll(combined));
    if (primary.length > 0) return primary;

    // Fallback: role-based list items inside a log region
    const logContainer = document.querySelector('[role="log"]');
    if (logContainer) {
      const items = Array.from(logContainer.querySelectorAll('[role="listitem"]'));
      if (items.length > 0) return items;
      // Try direct children as a last resort
      const children = Array.from(logContainer.children).filter(el =>
        el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
      );
      if (children.length > 0) return children;
    }

    // Class-fragment fallbacks
    return this._queryAll([
      '[class*="human-turn"]',
      '[class*="ai-turn"]',
      '[class*="ConversationItem"]',
    ]);
  }

  /**
   * @param {Element} element
   * @param {number} [index]
   * @returns {{ messageId: string, role: 'user'|'assistant'|'unknown', text: string, element: Element } | null}
   */
  extractMessageData(element, index = 0) {
    if (!element) return null;

    const messageId = this._deriveClaudeMessageId(element, index);
    const role = this._detectRole(element);

    // Extract text: prefer the prose content container inside the turn
    const textEl = this._queryFirst(
      [
        '[data-testid="message-content"]',
        '[class*="prose"]',
        '[class*="markdown"]',
        '[class*="message-content"]',
        'p',
      ],
      element
    ) || element;

    const text = this._getText(textEl);

    return { messageId, role, text, element };
  }

  detectTokenLimitWarning() {
    // Check for dedicated banner elements
    const bannerEl = this._queryFirst(CLAUDE_TOKEN_LIMIT_SELECTORS);
    if (bannerEl) return true;

    // Check visible text content for known warning patterns
    const bodyText = document.body.innerText || '';
    return CLAUDE_TOKEN_LIMIT_TEXT_PATTERNS.some(pattern => pattern.test(bodyText));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Derive a stable message ID for a Claude turn element.
   * @private
   */
  _deriveClaudeMessageId(el, index) {
    // Prefer explicit data attributes
    const explicit =
      el.dataset?.testid ||
      el.dataset?.messageId ||
      el.getAttribute('data-id') ||
      el.id;
    if (explicit) return `claude::${explicit}`;

    // Use conversation ID + index as fallback
    const convId = this.getConversationId();
    return `claude::${convId}::${index}`;
  }

  /**
   * Determine whether a turn element was authored by the user or the assistant.
   * @private
   * @param {Element} el
   * @returns {'user' | 'assistant' | 'unknown'}
   */
  _detectRole(el) {
    // 1. data-testid clue
    const testid = (el.dataset?.testid || '').toLowerCase();
    if (testid.includes('human') || testid.includes('user')) return 'user';
    if (testid.includes('ai') || testid.includes('assistant')) return 'assistant';

    // 2. Class fragment clue
    const cls = (el.className || '').toLowerCase();
    if (cls.includes('human')) return 'user';
    if (cls.includes('ai') || cls.includes('assistant') || cls.includes('claude')) return 'assistant';

    // 3. Check for a user-signal child element
    for (const sel of CLAUDE_USER_TURN_SIGNALS) {
      if (el.matches(sel) || el.querySelector(sel)) return 'user';
    }

    // 4. Heuristic: Claude logo / avatar SVG inside the turn → assistant
    const hasClaudeAvatar =
      el.querySelector('[aria-label*="Claude"]') ||
      el.querySelector('[alt*="Claude"]') ||
      el.querySelector('[class*="claude-avatar"]');
    if (hasClaudeAvatar) return 'assistant';

    // 5. Heuristic: user avatar → user
    const hasUserAvatar =
      el.querySelector('[aria-label*="You"]') ||
      el.querySelector('[alt*="you"]') ||
      el.querySelector('[class*="user-avatar"]');
    if (hasUserAvatar) return 'user';

    return 'unknown';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ChatGPTAdapter — chat.openai.com / chatgpt.com
// ════════════════════════════════════════════════════════════════════════════
//
// Selector strategy (in priority order):
//   1. data-message-author-role   →  most semantically stable attribute
//   2. data-testid attributes     →  stable in OpenAI test-tagged builds
//   3. ARIA roles / article tags  →  semantic HTML fallback
//   4. Known class fragments      →  last resort, treat as hints
//
// ChatGPT is a Next.js SPA. The DOM is fully dynamic.

const CHATGPT_CHAT_CONTAINER_SELECTORS = [
  // Primary: the <main> element houses the conversation thread
  'main',
  // Conversation-specific scroll containers (class names vary)
  '[class*="conversation-main"]',
  '[class*="chat-pg"]',
  '[class*="overflow-y-auto"]',
];

const CHATGPT_TOKEN_LIMIT_SELECTORS = [
  '[data-testid="context-limit-banner"]',
  '[class*="context-limit"]',
  '[class*="contextLimit"]',
  '[class*="limit-reached"]',
  '[class*="limit-warning"]',
];
const CHATGPT_TOKEN_LIMIT_TEXT_PATTERNS = [
  /context (window|limit) (is |has been )?reached/i,
  /conversation (is |has become )?too long/i,
  /maximum (context|token) length/i,
  /you've reached the (maximum|conversation) limit/i,
  /start a new (chat|conversation)/i,
];

export class ChatGPTAdapter extends PlatformAdapter {
  constructor() {
    super();
    this._platform = 'chatgpt';
  }

  // ── Interface implementation ───────────────────────────────────────────────

  getPlatformIdentifier() {
    return this._platform;
  }

  getConversationId() {
    // ChatGPT URL formats:
    //   https://chatgpt.com/c/<uuid>
    //   https://chat.openai.com/c/<uuid>
    const match = window.location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : 'unknown';
  }

  getChatContainer() {
    const container = this._queryFirst(CHATGPT_CHAT_CONTAINER_SELECTORS);
    if (!container) {
      console.warn('[AnyLLM][ChatGPTAdapter] Could not locate chat container.');
    }
    return container;
  }

  getMessageElements() {
    // Primary: data-message-author-role is the most reliable attribute
    const byRole = Array.from(
      document.querySelectorAll('[data-message-author-role]')
    );
    if (byRole.length > 0) return byRole;

    // Secondary: data-testid conversation-turn pattern
    const byTestId = Array.from(
      document.querySelectorAll('[data-testid^="conversation-turn-"]')
    );
    if (byTestId.length > 0) return byTestId;

    // Tertiary: article elements (semantic HTML)
    const byArticle = Array.from(document.querySelectorAll('article'));
    if (byArticle.length > 0) return byArticle;

    // Fallback: class-fragment approach inside main
    return this._queryAll([
      'main [class*="group/conversation-turn"]',
      'main [class*="ConversationItem"]',
    ]);
  }

  /**
   * @param {Element} element
   * @param {number} [index]
   * @returns {{ messageId: string, role: 'user'|'assistant'|'unknown', text: string, element: Element } | null}
   */
  extractMessageData(element, index = 0) {
    if (!element) return null;

    const messageId = this._deriveChatGPTMessageId(element, index);
    const role = this._detectRole(element);

    // Text extraction: ChatGPT wraps response content in markdown/prose divs
    const textEl = this._queryFirst(
      [
        '[data-message-author-role] .markdown',
        '[class*="prose"]',
        '[class*="markdown"]',
        '.whitespace-pre-wrap',
        'p',
      ],
      element
    ) || element;

    const text = this._getText(textEl);

    return { messageId, role, text, element };
  }

  detectTokenLimitWarning() {
    // Check for dedicated banner elements
    const bannerEl = this._queryFirst(CHATGPT_TOKEN_LIMIT_SELECTORS);
    if (bannerEl) return true;

    // Check visible text for warning patterns
    const bodyText = document.body.innerText || '';
    return CHATGPT_TOKEN_LIMIT_TEXT_PATTERNS.some(pattern => pattern.test(bodyText));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Derive a stable message ID for a ChatGPT turn element.
   * @private
   */
  _deriveChatGPTMessageId(el, index) {
    // Prefer the data-message-id attribute set by OpenAI
    const explicit =
      el.getAttribute('data-message-id') ||
      el.dataset?.messageId ||
      el.dataset?.testid ||
      el.id;
    if (explicit) return `chatgpt::${explicit}`;

    const convId = this.getConversationId();
    return `chatgpt::${convId}::${index}`;
  }

  /**
   * Determine role from a ChatGPT turn element.
   * @private
   * @param {Element} el
   * @returns {'user' | 'assistant' | 'unknown'}
   */
  _detectRole(el) {
    // 1. Most reliable: explicit attribute on the element itself
    const authorRole = el.getAttribute('data-message-author-role');
    if (authorRole === 'user') return 'user';
    if (authorRole === 'assistant') return 'assistant';

    // 2. Check descendant elements for the attribute (when the turn wrapper
    //    doesn't have it directly but its message child does)
    const descendantRole = el.querySelector('[data-message-author-role]');
    if (descendantRole) {
      const r = descendantRole.getAttribute('data-message-author-role');
      if (r === 'user') return 'user';
      if (r === 'assistant') return 'assistant';
    }

    // 3. data-testid pattern
    const testid = (el.dataset?.testid || '').toLowerCase();
    if (testid.includes('user')) return 'user';
    if (testid.includes('assistant') || testid.includes('gpt')) return 'assistant';

    // 4. Aria label on avatar elements inside the turn
    const userAvatar =
      el.querySelector('[aria-label="You"]') ||
      el.querySelector('[aria-label*="user"]') ||
      el.querySelector('[alt="User"]');
    if (userAvatar) return 'user';

    const assistantAvatar =
      el.querySelector('[aria-label="ChatGPT"]') ||
      el.querySelector('[aria-label*="assistant"]') ||
      el.querySelector('[alt="ChatGPT"]');
    if (assistantAvatar) return 'assistant';

    return 'unknown';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GeminiAdapter — gemini.google.com
// ════════════════════════════════════════════════════════════════════════════
//
// Selector strategy (in priority order):
//   1. Custom HTML elements   →  <conversation-turn>, <user-query>, <model-response>
//                                 Gemini uses Angular-style custom elements that are
//                                 the most stable identifiers on the page.
//   2. ARIA roles / labels    →  semantic fallback
//   3. Known class fragments  →  last resort; treat as hints, not guarantees
//
// Gemini is an Angular SPA with Shadow DOM components. Standard querySelector
// can reach the light DOM; Shadow DOM children require explicit piercing via
// el.shadowRoot. Where possible we avoid depending on Shadow DOM internals.

const GEMINI_CHAT_CONTAINER_SELECTORS = [
  // Primary: Gemini-specific custom element
  'chat-window',
  'conversation',
  // Fallback: ARIA landmark
  '[role="main"]',
  // Angular app root, very broad — last resort
  'main',
];

const GEMINI_RESPONSE_TEXT_SELECTORS = [
  'message-content',
  '[class*="message-content"]',
  '.markdown',
  '[class*="markdown"]',
  '[class*="prose"]',
  'p',
];

const GEMINI_TOKEN_LIMIT_SELECTORS = [
  '[class*="context-limit"]',
  '[class*="contextLimit"]',
  '[class*="limit-banner"]',
  '[class*="limit-warning"]',
  '[class*="conversation-limit"]',
];
const GEMINI_TOKEN_LIMIT_TEXT_PATTERNS = [
  /context (window|limit) (is |has been )?reached/i,
  /conversation (is |has become )?too long/i,
  /maximum (context|token) length/i,
  /this conversation is getting long/i,
  /start a new (chat|conversation)/i,
  /response was limited/i,
];

/**
 * Try to reach a selector through a host element's shadow root, if present.
 * Falls back to regular querySelector on the host itself.
 *
 * @param {Element} host
 * @param {string} selector
 * @returns {Element | null}
 */
function queryShadow(host, selector) {
  if (host.shadowRoot) {
    const el = host.shadowRoot.querySelector(selector);
    if (el) return el;
  }
  return host.querySelector(selector);
}

export class GeminiAdapter extends PlatformAdapter {
  constructor() {
    super();
    this._platform = 'gemini';
  }

  // ── Interface implementation ───────────────────────────────────────────────

  getPlatformIdentifier() {
    return this._platform;
  }

  getConversationId() {
    // Gemini URL formats:
    //   https://gemini.google.com/app/<conversationId>
    //   https://gemini.google.com/chat/<conversationId>  (older format)
    const match = window.location.pathname.match(/\/(app|chat)\/([a-zA-Z0-9_-]+)/);
    return match ? match[2] : 'unknown';
  }

  getChatContainer() {
    // 1. Try custom element first
    const chatWindow = document.querySelector('chat-window');
    if (chatWindow) return chatWindow;

    // 2. Try conversation element (may be inside shadow root of app root)
    const conversation = document.querySelector('conversation');
    if (conversation) return conversation;

    // 3. Try other selectors
    const container = this._queryFirst(GEMINI_CHAT_CONTAINER_SELECTORS);
    if (!container) {
      console.warn('[AnyLLM][GeminiAdapter] Could not locate chat container.');
    }
    return container;
  }

  getMessageElements() {
    // Primary: <conversation-turn> custom elements
    const turns = Array.from(document.querySelectorAll('conversation-turn'));
    if (turns.length > 0) return turns;

    // Secondary: ARIA listitem fallback
    const listItems = Array.from(document.querySelectorAll('[role="listitem"]'));
    if (listItems.length > 0) return listItems;

    // Tertiary: class-fragment approach
    return this._queryAll(['[class*="conversation-turn"]']);
  }

  /**
   * @param {Element} element - A <conversation-turn> or equivalent element
   * @param {number} [index]
   * @returns {{ messageId: string, role: 'user'|'assistant'|'unknown', text: string, element: Element } | null}
   */
  extractMessageData(element, index = 0) {
    if (!element) return null;

    const messageId = this._deriveGeminiMessageId(element, index);
    const role = this._detectRole(element);

    // Extract text depending on role
    let text = '';
    if (role === 'user') {
      text = this._extractUserText(element);
    } else if (role === 'assistant') {
      text = this._extractAssistantText(element);
    } else {
      // Unknown role: try both and take whichever is longer
      const userText = this._extractUserText(element);
      const assistantText = this._extractAssistantText(element);
      text = userText.length >= assistantText.length ? userText : assistantText;
      if (!text) text = this._getText(element);
    }

    if (!text) {
      text = this._getText(element);
    }

    return { messageId, role, text, element };
  }

  detectTokenLimitWarning() {
    // Check for dedicated banner/limit elements
    const bannerEl = this._queryFirst(GEMINI_TOKEN_LIMIT_SELECTORS);
    if (bannerEl) return true;

    // Check visible text for known patterns
    const bodyText = document.body.innerText || '';
    return GEMINI_TOKEN_LIMIT_TEXT_PATTERNS.some(pattern => pattern.test(bodyText));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Derive a stable message ID for a Gemini turn element.
   * @private
   */
  _deriveGeminiMessageId(el, index) {
    const explicit =
      el.getAttribute('data-id') ||
      el.getAttribute('data-turn-id') ||
      el.getAttribute('data-message-id') ||
      el.dataset?.messageId ||
      el.id;
    if (explicit) return `gemini::${explicit}`;

    const convId = this.getConversationId();
    return `gemini::${convId}::${index}`;
  }

  /**
   * Determine the role of a conversation turn.
   * Gemini nests <user-query> or <model-response> inside <conversation-turn>.
   * @private
   * @param {Element} el
   * @returns {'user' | 'assistant' | 'unknown'}
   */
  _detectRole(el) {
    // 1. Check for user-query custom element (direct child or in shadow DOM)
    const hasUserQuery =
      el.querySelector('user-query') ||
      el.querySelector('[class*="user-query"]') ||
      el.getAttribute('data-message-author-role') === 'user';
    if (hasUserQuery) return 'user';

    // 2. Check for model-response custom element
    const hasModelResponse =
      el.querySelector('model-response') ||
      el.querySelector('[class*="model-response"]') ||
      el.getAttribute('data-message-author-role') === 'assistant';
    if (hasModelResponse) return 'assistant';

    // 3. data-testid clues
    const testid = (el.dataset?.testid || '').toLowerCase();
    if (testid.includes('user') || testid.includes('human')) return 'user';
    if (testid.includes('model') || testid.includes('gemini') || testid.includes('assistant')) {
      return 'assistant';
    }

    // 4. ARIA label clues
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('you') || ariaLabel.includes('user')) return 'user';
    if (ariaLabel.includes('gemini') || ariaLabel.includes('model')) return 'assistant';

    // 5. Class fragment clues
    const cls = (el.className || '').toLowerCase();
    if (cls.includes('user') || cls.includes('human')) return 'user';
    if (cls.includes('model') || cls.includes('gemini') || cls.includes('assistant')) {
      return 'assistant';
    }

    return 'unknown';
  }

  /**
   * Extract text from the user portion of a turn.
   * @private
   */
  _extractUserText(el) {
    // Look for <user-query> custom element
    const userQueryEl = el.querySelector('user-query') ||
      el.querySelector('[class*="user-query"]');
    if (userQueryEl) {
      // Try its shadow root first
      const shadowText = queryShadow(userQueryEl, 'p, [class*="query-text"], textarea');
      if (shadowText) return this._getText(shadowText);
      return this._getText(userQueryEl);
    }
    return '';
  }

  /**
   * Extract text from the model-response portion of a turn.
   * @private
   */
  _extractAssistantText(el) {
    // Look for <model-response> custom element
    const modelRespEl = el.querySelector('model-response') ||
      el.querySelector('[class*="model-response"]');
    if (modelRespEl) {
      // Look for <message-content> or prose containers
      for (const sel of GEMINI_RESPONSE_TEXT_SELECTORS) {
        const textEl = queryShadow(modelRespEl, sel);
        if (textEl) return this._getText(textEl);
        const lightDom = modelRespEl.querySelector(sel);
        if (lightDom) return this._getText(lightDom);
      }
      return this._getText(modelRespEl);
    }

    // Fallback: look for message-content directly inside turn
    const msgContent = el.querySelector('message-content') ||
      el.querySelector('[class*="message-content"]');
    if (msgContent) return this._getText(msgContent);

    return '';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Adapter factory
// ════════════════════════════════════════════════════════════════════════════

/**
 * Instantiate the correct adapter for the given hostname.
 * @param {string} hostname
 * @returns {PlatformAdapter | null}
 */
export function createAdapter(hostname) {
  if (hostname.includes('claude.ai')) return new ClaudeAdapter();
  if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) return new ChatGPTAdapter();
  if (hostname.includes('gemini.google.com')) return new GeminiAdapter();
  return null;
}
