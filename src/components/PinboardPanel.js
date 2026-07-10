// src/components/PinboardPanel.js
// AnyLLM — Pinboard Panel (P2.3)
//
// A sliding side panel (similar to ContextSidePanel but for pins) that renders
// all pinned messages for the current conversation, supports drag-and-drop
// reordering, and provides unpin + copy actions per card.
//
// Public API:
//   PinboardPanel.render(pins, options)  — create / refresh with current pins
//   PinboardPanel.open()
//   PinboardPanel.close()
//   PinboardPanel.toggle()
//   PinboardPanel.destroy()
//   PinboardPanel.addPin(pin)           — optimistic add without full reload
//   PinboardPanel.removePin(pinId)      — optimistic remove without full reload

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_ID      = 'anyllm-pinboard-panel';
const TOGGLE_BTN_ID = 'anyllm-pinboard-toggle';
const STYLE_ID      = 'anyllm-pinboard-styles';
const Z_INDEX       = '2147483635';

// Platform accent colours (match ContextSidePanel palette)
const ROLE_COLORS = {
  user:      '#60a5fa',
  assistant: '#a78bfa',
  unknown:   '#94a3b8',
};

// ── Styles ────────────────────────────────────────────────────────────────────

function buildStyles() {
  return `
/* ── AnyLLM Pinboard Panel ── */

#${PANEL_ID} {
  position: fixed;
  top: 0;
  left: 0;
  width: 380px;
  height: 100vh;
  background: linear-gradient(160deg, #0d1117 0%, #131b2e 100%);
  color: #e2e8f0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  line-height: 1.55;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  box-shadow: 4px 0 32px rgba(0, 0, 0, 0.55);
  border-right: 1px solid rgba(245, 158, 11, 0.2);
  transform: translateX(-100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
#${PANEL_ID}.anyllm-pb-open {
  transform: translateX(0);
}

/* Header */
.anyllm-pb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px;
  background: rgba(245, 158, 11, 0.07);
  border-bottom: 1px solid rgba(245, 158, 11, 0.18);
  flex-shrink: 0;
}
.anyllm-pb-title {
  font-size: 14px;
  font-weight: 700;
  color: #fbbf24;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.03em;
}
.anyllm-pb-pin-icon {
  font-size: 16px;
  animation: anyllm-pb-sway 3s ease-in-out infinite;
}
@keyframes anyllm-pb-sway {
  0%, 100% { transform: rotate(-8deg); }
  50%       { transform: rotate(8deg); }
}
.anyllm-pb-close-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
}
.anyllm-pb-close-btn:hover { background: rgba(245,158,11,0.12); color: #fbbf24; }

/* Subtitle / meta */
.anyllm-pb-meta {
  padding: 8px 16px;
  font-size: 11px;
  color: #64748b;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.anyllm-pb-count {
  background: rgba(245,158,11,0.12);
  color: #f59e0b;
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 10.5px;
  font-weight: 600;
}

/* Scrollable body */
.anyllm-pb-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(245,158,11,0.25) transparent;
}
.anyllm-pb-body::-webkit-scrollbar { width: 4px; }
.anyllm-pb-body::-webkit-scrollbar-thumb {
  background: rgba(245,158,11,0.3);
  border-radius: 999px;
}

/* Empty state */
.anyllm-pb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: #374151;
  font-size: 12.5px;
  text-align: center;
  gap: 10px;
}
.anyllm-pb-empty-icon { font-size: 36px; opacity: 0.4; }

/* Pin card */
.anyllm-pb-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
  cursor: grab;
  position: relative;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
  user-select: none;
  border-left: 3px solid rgba(245, 158, 11, 0.5);
}
.anyllm-pb-card:hover {
  border-color: rgba(245,158,11,0.35);
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
}
.anyllm-pb-card.anyllm-pb-dragging {
  opacity: 0.45;
  cursor: grabbing;
}
.anyllm-pb-card.anyllm-pb-drag-over {
  border-color: rgba(245,158,11,0.7);
  box-shadow: 0 0 0 2px rgba(245,158,11,0.25);
  transform: scale(1.01);
}

/* Card header row */
.anyllm-pb-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
  gap: 8px;
}
.anyllm-pb-card-role {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.anyllm-pb-card-meta {
  font-size: 10px;
  color: #374151;
  white-space: nowrap;
}
.anyllm-pb-card-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.anyllm-pb-card:hover .anyllm-pb-card-actions { opacity: 1; }

.anyllm-pb-action-btn {
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 12px;
  transition: background 0.13s, color 0.13s;
}
.anyllm-pb-action-btn:hover { background: rgba(245,158,11,0.12); color: #fbbf24; }
.anyllm-pb-action-btn.unpin:hover { background: rgba(239,68,68,0.12); color: #f87171; }

/* Card body — truncated text */
.anyllm-pb-card-text {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.anyllm-pb-card-text.expanded {
  -webkit-line-clamp: unset;
}

/* Expand / collapse toggle */
.anyllm-pb-expand-btn {
  background: none;
  border: none;
  color: #6366f1;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 0;
  display: block;
  margin-top: 4px;
  transition: color 0.15s;
}
.anyllm-pb-expand-btn:hover { color: #818cf8; }

/* Drag handle */
.anyllm-pb-drag-handle {
  position: absolute;
  top: 50%;
  left: 6px;
  transform: translateY(-50%);
  color: rgba(255,255,255,0.12);
  font-size: 13px;
  cursor: grab;
  line-height: 1;
  user-select: none;
}

/* Footer */
.anyllm-pb-footer {
  flex-shrink: 0;
  padding: 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: #374151;
}
.anyllm-pb-clear-btn {
  background: none;
  border: 1px solid rgba(239,68,68,0.25);
  color: #ef4444;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.anyllm-pb-clear-btn:hover { background: rgba(239,68,68,0.1); }

/* Floating toggle button (left edge, above ContextPanel's right-edge toggle) */
#${TOGGLE_BTN_ID} {
  position: fixed;
  left: 0;
  top: calc(50% + 40px);
  transform: translateY(-50%);
  z-index: ${Number(Z_INDEX) - 1};
  background: linear-gradient(135deg, #b45309, #d97706);
  color: #fff;
  border: none;
  border-radius: 0 10px 10px 0;
  padding: 12px 8px;
  cursor: pointer;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  box-shadow: 2px 0 16px rgba(180,83,9,0.4);
  transition: padding 0.2s, background 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
}
#${TOGGLE_BTN_ID}:hover {
  background: linear-gradient(135deg, #92400e, #b45309);
  padding-left: 12px;
}
`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

const getPanel = () => document.getElementById(PANEL_ID);

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Card HTML builder ─────────────────────────────────────────────────────────

/**
 * @param {import('../services/types.js').Pin} pin
 * @returns {string}
 */
function buildCardHTML(pin) {
  const roleColor = ROLE_COLORS[pin.role] || ROLE_COLORS.unknown;
  const preview   = pin.text.length > 350 ? pin.text.slice(0, 350) + '…' : pin.text;
  const hasMore   = pin.text.length > 350;

  return `
    <div class="anyllm-pb-card"
         draggable="true"
         data-pin-id="${esc(pin.id)}"
         data-message-id="${esc(pin.messageId)}">
      <span class="anyllm-pb-drag-handle" aria-hidden="true">⋮⋮</span>
      <div class="anyllm-pb-card-header">
        <span class="anyllm-pb-card-role" style="color:${roleColor}">
          ${esc(pin.role)}
        </span>
        <span class="anyllm-pb-card-meta">${esc(fmtDate(pin.pinnedAt))}</span>
        <div class="anyllm-pb-card-actions">
          <button class="anyllm-pb-action-btn copy-pin"
                  data-pin-id="${esc(pin.id)}"
                  title="Copy text">📋</button>
          <button class="anyllm-pb-action-btn unpin"
                  data-pin-id="${esc(pin.id)}"
                  title="Unpin">✕</button>
        </div>
      </div>
      <div class="anyllm-pb-card-text" data-pin-id="${esc(pin.id)}">${esc(preview)}</div>
      ${hasMore ? `
        <button class="anyllm-pb-expand-btn" data-pin-id="${esc(pin.id)}"
                data-full-text="${esc(pin.text)}">Show more ▾</button>
      ` : ''}
    </div>
  `;
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

/** @type {string | null} ID of the card being dragged */
let _dragId = null;

/** @type {Function | null} reorder callback provided at render time */
let _onReorder = null;

function wireDragDrop(panel) {
  const body = panel.querySelector('.anyllm-pb-body');
  if (!body) return;

  body.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.anyllm-pb-card');
    if (!card) return;
    _dragId = card.dataset.pinId;
    card.classList.add('anyllm-pb-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _dragId);
  });

  body.addEventListener('dragend', (e) => {
    const card = e.target.closest('.anyllm-pb-card');
    if (card) card.classList.remove('anyllm-pb-dragging');
    body.querySelectorAll('.anyllm-pb-drag-over').forEach(el => el.classList.remove('anyllm-pb-drag-over'));
  });

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    const card = e.target.closest('.anyllm-pb-card');
    body.querySelectorAll('.anyllm-pb-drag-over').forEach(el => el.classList.remove('anyllm-pb-drag-over'));
    if (card && card.dataset.pinId !== _dragId) {
      card.classList.add('anyllm-pb-drag-over');
    }
  });

  body.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetCard = e.target.closest('.anyllm-pb-card');
    if (!targetCard || !_dragId) return;

    const targetId = targetCard.dataset.pinId;
    if (targetId === _dragId) return;

    // Reorder DOM nodes immediately for snappy UX
    const dragCard = body.querySelector(`[data-pin-id="${_dragId}"]`);
    if (!dragCard) return;

    const cards = [...body.querySelectorAll('.anyllm-pb-card')];
    const dragIdx  = cards.findIndex(c => c.dataset.pinId === _dragId);
    const targetIdx = cards.findIndex(c => c.dataset.pinId === targetId);

    if (dragIdx < targetIdx) {
      targetCard.after(dragCard);
    } else {
      targetCard.before(dragCard);
    }

    // Persist new order
    const newOrder = [...body.querySelectorAll('.anyllm-pb-card')].map(c => c.dataset.pinId);
    if (typeof _onReorder === 'function') {
      _onReorder(newOrder);
    }

    targetCard.classList.remove('anyllm-pb-drag-over');
    _dragId = null;
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

/** @type {Function | null} */
let _onUnpin = null;

function wireEvents(panel) {
  // Close button
  panel.querySelector('.anyllm-pb-close-btn')?.addEventListener('click', () => PinboardPanel.close());

  // Clear all
  panel.querySelector('.anyllm-pb-clear-btn')?.addEventListener('click', () => {
    if (confirm('Remove all pinned messages? This cannot be undone.')) {
      if (typeof _onUnpin === 'function') {
        const cards = panel.querySelectorAll('.anyllm-pb-card');
        cards.forEach(c => _onUnpin(c.dataset.pinId, true));
      }
    }
  });

  // Card-level actions (event delegation)
  panel.querySelector('.anyllm-pb-body')?.addEventListener('click', (e) => {
    // Copy
    const copyBtn = e.target.closest('.copy-pin');
    if (copyBtn) {
      const pinId = copyBtn.dataset.pinId;
      const card  = panel.querySelector(`.anyllm-pb-card[data-pin-id="${pinId}"]`);
      const fullText = card?.querySelector('.anyllm-pb-expand-btn')?.dataset.fullText
        || card?.querySelector('.anyllm-pb-card-text')?.textContent
        || '';
      navigator.clipboard.writeText(fullText.trim()).then(() => {
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1600);
      });
      return;
    }

    // Unpin
    const unpinBtn = e.target.closest('.unpin');
    if (unpinBtn) {
      const pinId = unpinBtn.dataset.pinId;
      if (typeof _onUnpin === 'function') _onUnpin(pinId, false);
      return;
    }

    // Expand / collapse
    const expandBtn = e.target.closest('.anyllm-pb-expand-btn');
    if (expandBtn) {
      const pinId   = expandBtn.dataset.pinId;
      const textEl  = panel.querySelector(`.anyllm-pb-card-text[data-pin-id="${pinId}"]`);
      const isExp   = textEl?.classList.contains('expanded');
      if (textEl) {
        textEl.classList.toggle('expanded');
        if (!isExp) {
          textEl.textContent = expandBtn.dataset.fullText || textEl.textContent;
        } else {
          // Re-truncate to first 350 chars
          const full = expandBtn.dataset.fullText || textEl.textContent;
          textEl.textContent = full.slice(0, 350) + (full.length > 350 ? '…' : '');
        }
        expandBtn.textContent = isExp ? 'Show more ▾' : 'Show less ▴';
      }
    }
  });

  wireDragDrop(panel);
}

// ── Panel builder ─────────────────────────────────────────────────────────────

/**
 * @param {import('../services/types.js').Pin[]} pins
 * @param {string} platform
 * @param {string} conversationId
 * @returns {string}
 */
function buildPanelHTML(pins, platform, conversationId) {
  const count = pins.length;
  const cardsHTML = count === 0
    ? `<div class="anyllm-pb-empty">
         <span class="anyllm-pb-empty-icon">📌</span>
         <span>No pins yet.<br>Hover a message and click 📌 to pin it.</span>
       </div>`
    : pins.map(buildCardHTML).join('');

  return `
    <div class="anyllm-pb-header">
      <div class="anyllm-pb-title">
        <span class="anyllm-pb-pin-icon">📌</span>
        Pinboard
      </div>
      <button class="anyllm-pb-close-btn" aria-label="Close pinboard">✕</button>
    </div>

    <div class="anyllm-pb-meta">
      <span>${esc(platform)} · ${esc(conversationId)}</span>
      <span class="anyllm-pb-count">${count} pin${count !== 1 ? 's' : ''}</span>
    </div>

    <div class="anyllm-pb-body">${cardsHTML}</div>

    <div class="anyllm-pb-footer">
      <span>Drag cards to reorder</span>
      ${count > 0 ? '<button class="anyllm-pb-clear-btn">Clear all</button>' : ''}
    </div>
  `;
}

// ── Public API object ─────────────────────────────────────────────────────────

/** @type {import('../services/types.js').Pin[]} */
let _pins = [];
let _platform = '';
let _conversationId = '';

const PinboardPanel = {
  /**
   * Create or refresh the panel.
   *
   * @param {import('../services/types.js').Pin[]} pins
   * @param {{
   *   platform:       string,
   *   conversationId: string,
   *   onUnpin:        (pinId: string, clearAll: boolean) => void,
   *   onReorder:      (orderedPinIds: string[]) => void,
   * }} options
   */
  render(pins, { platform = 'unknown', conversationId = '', onUnpin, onReorder } = {}) {
    _pins           = pins;
    _platform       = platform;
    _conversationId = conversationId;
    _onUnpin        = onUnpin  || null;
    _onReorder      = onReorder || null;

    // Inject styles once
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id    = STYLE_ID;
      style.textContent = buildStyles();
      document.head.appendChild(style);
    }

    // Create or reuse panel element
    let panel = getPanel();
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'complementary');
      panel.setAttribute('aria-label', 'AnyLLM Pinboard');
      document.body.appendChild(panel);
    }

    panel.innerHTML = buildPanelHTML(pins, platform, conversationId);
    wireEvents(panel);

    // Floating toggle button
    if (!document.getElementById(TOGGLE_BTN_ID)) {
      const toggleBtn = document.createElement('button');
      toggleBtn.id    = TOGGLE_BTN_ID;
      toggleBtn.title = 'Toggle Pinboard';
      toggleBtn.innerHTML = '📌 Pins';
      toggleBtn.addEventListener('click', () => PinboardPanel.toggle());
      document.body.appendChild(toggleBtn);
    }
  },

  /** Open the panel. */
  open() {
    getPanel()?.classList.add('anyllm-pb-open');
  },

  /** Close the panel. */
  close() {
    getPanel()?.classList.remove('anyllm-pb-open');
  },

  /** Toggle open/closed. */
  toggle() {
    getPanel()?.classList.toggle('anyllm-pb-open');
  },

  /**
   * Optimistically add a pin card to the panel without a full re-render.
   * @param {import('../services/types.js').Pin} pin
   */
  addPin(pin) {
    const panel = getPanel();
    if (!panel) return;

    // Remove empty state if present
    const empty = panel.querySelector('.anyllm-pb-empty');
    if (empty) empty.remove();

    const body = panel.querySelector('.anyllm-pb-body');
    if (body) {
      const tmp = document.createElement('div');
      tmp.innerHTML = buildCardHTML(pin);
      const card = tmp.firstElementChild;
      if (card) {
        body.appendChild(card);
        // Update count chip
        _pins = [..._pins, pin];
        const chip = panel.querySelector('.anyllm-pb-count');
        if (chip) chip.textContent = `${_pins.length} pin${_pins.length !== 1 ? 's' : ''}`;
        // Ensure clear-all button exists
        const footer = panel.querySelector('.anyllm-pb-footer');
        if (footer && !footer.querySelector('.anyllm-pb-clear-btn')) {
          const btn = document.createElement('button');
          btn.className = 'anyllm-pb-clear-btn';
          btn.textContent = 'Clear all';
          btn.addEventListener('click', () => {
            if (confirm('Remove all pinned messages?')) {
              _pins.forEach(p => typeof _onUnpin === 'function' && _onUnpin(p.id, true));
            }
          });
          footer.appendChild(btn);
        }
        // Re-wire drag-drop for new card
        wireDragDrop(panel);
      }
    }
  },

  /**
   * Optimistically remove a pin card.
   * @param {string} pinId
   */
  removePin(pinId) {
    const panel = getPanel();
    if (!panel) return;

    panel.querySelector(`.anyllm-pb-card[data-pin-id="${pinId}"]`)?.remove();
    _pins = _pins.filter(p => p.id !== pinId);

    const chip = panel.querySelector('.anyllm-pb-count');
    if (chip) chip.textContent = `${_pins.length} pin${_pins.length !== 1 ? 's' : ''}`;

    // Show empty state if no pins remain
    const body = panel.querySelector('.anyllm-pb-body');
    if (body && _pins.length === 0) {
      body.innerHTML = `<div class="anyllm-pb-empty">
        <span class="anyllm-pb-empty-icon">📌</span>
        <span>No pins yet.<br>Hover a message and click 📌 to pin it.</span>
      </div>`;
      panel.querySelector('.anyllm-pb-clear-btn')?.remove();
    }
  },

  /** Remove panel + toggle from DOM. */
  destroy() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(TOGGLE_BTN_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    _pins = [];
  },

  get isOpen() {
    return !!getPanel()?.classList.contains('anyllm-pb-open');
  },
  get isRendered() {
    return !!getPanel();
  },
};

export default PinboardPanel;
export { PinboardPanel };
