// src/components/messageToolbar.js
// AnyLLM — Per-Message Hover Toolbar (P2.3 foundation, extended in P2.4/P2.5)
//
// Injects a small floating action toolbar onto each message element on hover.
// The toolbar is shared infrastructure for:
//   P2.3 — Pin button
//   P2.4 — Delete button  (added in P2.4)
//   P2.5 — Edit button    (added in P2.5)
//
// Design principles:
//   • One toolbar element per page; re-positioned via CSS `position: fixed`
//     following the hovered message — avoids thousands of DOM nodes.
//   • Injected styles are namespaced with `anyllm-tb-` to avoid host-page conflicts.
//   • Buttons fire callbacks registered via `registerAction(id, config)`.

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOOLBAR_ID     = 'anyllm-msg-toolbar';
const STYLE_ID       = 'anyllm-toolbar-styles';
const DATA_MSG_ID    = 'data-anyllm-msg-id';
const DATA_ROLE      = 'data-anyllm-role';

// How many px above the top-right corner of the message the toolbar floats
const TOOLBAR_OFFSET_Y = 6;
const TOOLBAR_OFFSET_X = 8;

// ── Styles ────────────────────────────────────────────────────────────────────

function buildStyles() {
  return `
#${TOOLBAR_ID} {
  position: fixed;
  z-index: 2147483630;
  display: none;
  align-items: center;
  gap: 4px;
  background: rgba(15, 17, 27, 0.92);
  border: 1px solid rgba(99, 102, 241, 0.28);
  border-radius: 10px;
  padding: 4px 6px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.45);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: opacity 0.15s ease;
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

#${TOOLBAR_ID}.anyllm-tb-visible {
  display: flex;
}

.anyllm-tb-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 5px 6px;
  border-radius: 7px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.anyllm-tb-btn:hover {
  background: rgba(99, 102, 241, 0.15);
  color: #c7d2fe;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}

.anyllm-tb-btn:active {
  transform: translateY(0);
}
.anyllm-tb-btn.anyllm-tb-active {
  color: #818cf8;
  background: rgba(99,102,241,0.18);
}
.anyllm-tb-btn.anyllm-tb-pinned {
  color: #f59e0b;
}
.anyllm-tb-btn.anyllm-tb-pinned:hover {
  color: #fbbf24;
  background: rgba(245,158,11,0.15);
}

/* Tooltip */
.anyllm-tb-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(15,17,27,0.95);
  color: #e2e8f0;
  font-size: 10.5px;
  font-weight: 500;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid rgba(99,102,241,0.2);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.anyllm-tb-btn:hover::after { opacity: 1; }

/* Divider between button groups */
.anyllm-tb-divider {
  width: 1px;
  height: 16px;
  background: rgba(255,255,255,0.08);
  margin: 0 2px;
}

/* Pinned-message highlight ring on the message itself */
[data-anyllm-pinned="true"] {
  outline: 2px solid rgba(245, 158, 11, 0.3) !important;
  outline-offset: 2px !important;
  border-radius: 4px;
}
`;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, { icon: string, tooltip: string, onClick: Function, showFor?: string[] }>} */
const _actions = new Map();

/** Currently-hovered message element */
let _currentEl = null;

/** Hide-delay timer — avoids flicker when cursor moves between msg and toolbar */
let _hideTimer = null;

// ── Toolbar element ───────────────────────────────────────────────────────────

function getToolbar() {
  return document.getElementById(TOOLBAR_ID);
}

function createToolbar() {
  if (document.getElementById(STYLE_ID)) return; // already injected

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildStyles();
  document.head.appendChild(style);

  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'AnyLLM message actions');
  document.body.appendChild(toolbar);

  // Keep toolbar visible while cursor is over it
  toolbar.addEventListener('mouseenter', () => {
    clearTimeout(_hideTimer);
  });
  toolbar.addEventListener('mouseleave', () => {
    scheduleHide();
  });
}

// ── Positioning ───────────────────────────────────────────────────────────────

/**
 * Position the toolbar at the top-right corner of the given element.
 * @param {Element} el
 */
function positionOver(el) {
  const toolbar = getToolbar();
  if (!toolbar) return;

  const rect = el.getBoundingClientRect();
  const tbRect = toolbar.getBoundingClientRect();

  // Anchor to top-right of message, clamp to viewport
  let top = rect.top - tbRect.height - TOOLBAR_OFFSET_Y;
  let left = rect.right - tbRect.width - TOOLBAR_OFFSET_X;

  // If toolbar would go above viewport, flip below the message
  if (top < 8) top = rect.bottom + TOOLBAR_OFFSET_Y;
  // Clamp left to viewport
  if (left < 8) left = 8;

  toolbar.style.top  = `${top}px`;
  toolbar.style.left = `${left}px`;
}

// ── Toolbar rendering ─────────────────────────────────────────────────────────

/**
 * Rebuild toolbar button HTML for a given message role.
 * Filters actions by `showFor` if set.
 *
 * @param {string} role      — 'user' | 'assistant' | 'unknown'
 * @param {string} messageId
 * @param {Map<string, boolean>} pinnedSet — set of currently-pinned messageIds
 */
function renderToolbar(role, messageId, pinnedSet = new Map()) {
  const toolbar = getToolbar();
  if (!toolbar) return;

  toolbar.innerHTML = '';

  let first = true;
  for (const [actionId, cfg] of _actions) {
    // Filter by role if `showFor` is specified
    if (cfg.showFor && !cfg.showFor.includes(role) && !cfg.showFor.includes('all')) {
      continue;
    }

    if (!first) {
      // Add a subtle divider between groups if action has `groupBefore: true`
      if (cfg.groupBefore) {
        const div = document.createElement('span');
        div.className = 'anyllm-tb-divider';
        toolbar.appendChild(div);
      }
    }
    first = false;

    const btn = document.createElement('button');
    btn.className = 'anyllm-tb-btn';
    btn.dataset.action = actionId;
    btn.setAttribute('data-tooltip', cfg.tooltip);
    btn.setAttribute('aria-label', cfg.tooltip);
    btn.innerHTML = cfg.icon;

    // Apply active / pinned state
    if (actionId === 'pin' && pinnedSet.has(messageId)) {
      btn.classList.add('anyllm-tb-pinned');
      btn.setAttribute('data-tooltip', 'Unpin message');
      btn.setAttribute('aria-label', 'Unpin message');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cfg.onClick({ messageId, role, element: _currentEl, button: btn });
    });

    toolbar.appendChild(btn);
  }
}

// ── Visibility helpers ────────────────────────────────────────────────────────

function showToolbar() {
  clearTimeout(_hideTimer);
  getToolbar()?.classList.add('anyllm-tb-visible');
}

function scheduleHide(delay = 250) {
  clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    getToolbar()?.classList.remove('anyllm-tb-visible');
    _currentEl = null;
  }, delay);
}

// ── Message element instrumentation ──────────────────────────────────────────

/**
 * Attach hover listeners to a message element so the toolbar appears/disappears.
 *
 * @param {Element}  el
 * @param {string}   messageId
 * @param {string}   role
 * @param {Function} getPinnedSet  — () => Map<messageId, boolean>  (async-resolved by caller)
 */
function attachToMessage(el, messageId, role, getPinnedSet) {
  // Idempotent — don't double-bind
  if (el.dataset.anyllmBound === '1') return;
  el.dataset.anyllmBound = '1';
  el.setAttribute(DATA_MSG_ID, messageId);
  el.setAttribute(DATA_ROLE, role);

  el.addEventListener('mouseenter', async () => {
    clearTimeout(_hideTimer);
    _currentEl = el;

    const pinnedSet = typeof getPinnedSet === 'function' ? (await getPinnedSet()) : new Map();
    renderToolbar(role, messageId, pinnedSet);
    showToolbar();
    positionOver(el);
  });

  el.addEventListener('mousemove', () => {
    if (_currentEl === el) positionOver(el);
  });

  el.addEventListener('mouseleave', () => {
    scheduleHide();
  });
}

// ── Pinned-state visual mark ──────────────────────────────────────────────────

/**
 * Set or clear the pinned outline ring on a message element.
 * @param {string}  messageId
 * @param {boolean} isPinned
 */
function setMessagePinnedState(messageId, isPinned) {
  const el = document.querySelector(`[${DATA_MSG_ID}="${messageId}"]`);
  if (!el) return;
  if (isPinned) {
    el.setAttribute('data-anyllm-pinned', 'true');
  } else {
    el.removeAttribute('data-anyllm-pinned');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a toolbar action.
 *
 * @param {string} id   — unique action identifier (e.g. 'pin', 'delete', 'edit')
 * @param {{
 *   icon:       string,        — SVG or emoji string rendered as button innerHTML
 *   tooltip:    string,        — hover tooltip text
 *   onClick:    Function,      — ({ messageId, role, element, button }) => void
 *   showFor?:   string[],      — roles this button applies to; omit for all
 *   groupBefore?: boolean,     — insert a divider before this button
 * }} config
 */
function registerAction(id, config) {
  _actions.set(id, config);
}

/**
 * Remove a previously registered action.
 * @param {string} id
 */
function unregisterAction(id) {
  _actions.delete(id);
}

/**
 * Initialise the toolbar DOM. Must be called once before attachToMessage().
 */
function init() {
  createToolbar();
}

/**
 * Tear down toolbar and all associated styles.
 */
function destroy() {
  document.getElementById(TOOLBAR_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
  _actions.clear();
  clearTimeout(_hideTimer);
}

const MessageToolbar = {
  init,
  destroy,
  registerAction,
  unregisterAction,
  attachToMessage,
  setMessagePinnedState,
};

export default MessageToolbar;
export { MessageToolbar, registerAction, unregisterAction, attachToMessage, setMessagePinnedState };
