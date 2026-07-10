// src/components/HighlightsPanel.js
// AnyLLM — Highlights Panel (P2.6)
//
// A sliding side panel that renders all highlights for the current conversation,
// grouped by colour (Yellow, Green, Red).
//
// Public API:
//   HighlightsPanel.render(highlights, options)
//   HighlightsPanel.open()
//   HighlightsPanel.close()
//   HighlightsPanel.toggle()
//   HighlightsPanel.destroy()
//   HighlightsPanel.addHighlight(highlight)
//   HighlightsPanel.removeHighlight(highlightId)

'use strict';

const PANEL_ID      = 'anyllm-highlights-panel';
const STYLE_ID      = 'anyllm-highlights-styles';
const Z_INDEX       = '2147483636';

const COLOR_MAP = {
  yellow: { label: 'Yellow', bg: 'rgba(250, 204, 21, 0.1)', border: 'rgba(250, 204, 21, 0.4)' },
  green:  { label: 'Green', bg: 'rgba(74, 222, 128, 0.1)', border: 'rgba(74, 222, 128, 0.4)' },
  red:    { label: 'Red', bg: 'rgba(248, 113, 113, 0.1)', border: 'rgba(248, 113, 113, 0.4)' }
};

function buildStyles() {
  return `
/* ── AnyLLM Highlights Panel ── */

#${PANEL_ID} {
  position: fixed;
  top: 0;
  right: 0;
  width: 380px;
  height: 100vh;
  background: linear-gradient(160deg, #0f172a 0%, #1e1b4b 100%);
  color: #e2e8f0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  line-height: 1.55;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 32px rgba(0, 0, 0, 0.55);
  border-left: 1px solid rgba(167, 139, 250, 0.2);
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
#${PANEL_ID}.anyllm-hl-open {
  transform: translateX(0);
}

/* Header */
.anyllm-hl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px;
  background: rgba(167, 139, 250, 0.07);
  border-bottom: 1px solid rgba(167, 139, 250, 0.18);
  flex-shrink: 0;
}
.anyllm-hl-title {
  font-size: 14px;
  font-weight: 700;
  color: #c4b5fd;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.03em;
}
.anyllm-hl-close-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
}
.anyllm-hl-close-btn:hover { background: rgba(167,139,250,0.12); color: #c4b5fd; }

/* Body */
.anyllm-hl-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.anyllm-hl-body::-webkit-scrollbar { width: 6px; }
.anyllm-hl-body::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
.anyllm-hl-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
.anyllm-hl-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

/* Empty state */
.anyllm-hl-empty {
  text-align: center;
  padding: 40px 20px;
  color: #64748b;
}

/* Color Group */
.anyllm-hl-group-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  gap: 6px;
}
.anyllm-hl-group-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

/* Highlight Card */
.anyllm-hl-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  position: relative;
  transition: border-color 0.15s, transform 0.15s;
}
.anyllm-hl-card:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.15);
}
.anyllm-hl-text {
  font-size: 13px;
  color: #e2e8f0;
  word-break: break-word;
  margin-bottom: 8px;
  line-height: 1.5;
}

/* Card Actions */
.anyllm-hl-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
  padding-top: 8px;
}
.anyllm-hl-action-btn {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.05);
  color: #cbd5e1;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.anyllm-hl-action-btn:hover {
  background: rgba(255,255,255,0.1);
  color: #fff;
}
.anyllm-hl-action-btn.delete:hover {
  background: rgba(248,113,113,0.15);
  color: #fca5a5;
  border-color: rgba(248,113,113,0.2);
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

let _options = null;

function _createPanel() {
  ensureStyles();
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.dataset.anyllmInjected = '1';
  
  // Header
  const header = document.createElement('div');
  header.className = 'anyllm-hl-header';
  
  const title = document.createElement('div');
  title.className = 'anyllm-hl-title';
  title.innerHTML = '<span>🖍 Highlights</span>';
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'anyllm-hl-close-btn';
  closeBtn.innerHTML = '✕';
  closeBtn.title = 'Close panel';
  closeBtn.addEventListener('click', close);
  
  header.append(title, closeBtn);
  
  // Body
  const body = document.createElement('div');
  body.className = 'anyllm-hl-body';
  body.id = `${PANEL_ID}-body`;
  
  panel.append(header, body);
  document.body.appendChild(panel);
  
  return panel;
}

function _renderGroup(color, highlights) {
  if (!highlights || highlights.length === 0) return null;

  const group = document.createElement('div');
  group.className = 'anyllm-hl-group';
  group.dataset.color = color;

  const conf = COLOR_MAP[color] || COLOR_MAP.yellow;

  const title = document.createElement('div');
  title.className = 'anyllm-hl-group-title';
  title.innerHTML = `<div class="anyllm-hl-group-swatch" style="background: ${conf.border}"></div>${conf.label} (${highlights.length})`;
  
  group.appendChild(title);

  for (const hl of highlights) {
    const card = document.createElement('div');
    card.className = 'anyllm-hl-card';
    card.dataset.id = hl.id;
    card.style.borderLeft = `3px solid ${conf.border}`;
    card.style.background = `linear-gradient(90deg, ${conf.bg} 0%, rgba(15, 23, 42, 0.6) 100%)`;

    const text = document.createElement('div');
    text.className = 'anyllm-hl-text';
    text.textContent = hl.text;

    const actions = document.createElement('div');
    actions.className = 'anyllm-hl-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'anyllm-hl-action-btn';
    copyBtn.innerHTML = '📋 Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(hl.text);
      copyBtn.innerHTML = '✓ Copied';
      setTimeout(() => copyBtn.innerHTML = '📋 Copy', 1500);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'anyllm-hl-action-btn delete';
    delBtn.innerHTML = '✕ Remove';
    delBtn.addEventListener('click', () => {
      if (_options && _options.onRemove) _options.onRemove(hl.id);
    });

    actions.append(copyBtn, delBtn);
    card.append(text, actions);
    group.appendChild(card);
  }

  return group;
}

function _renderContent(highlights) {
  const body = document.getElementById(`${PANEL_ID}-body`);
  if (!body) return;
  body.innerHTML = '';

  if (!highlights || highlights.length === 0) {
    body.innerHTML = `<div class="anyllm-hl-empty">
      <div style="font-size: 24px; margin-bottom: 10px;">🖍</div>
      No highlights yet.<br>Select text in any message to highlight it.
    </div>`;
    return;
  }

  const colors = ['yellow', 'green', 'red'];
  for (const c of colors) {
    const group = highlights.filter(h => h.color === c);
    const node = _renderGroup(c, group);
    if (node) body.appendChild(node);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the panel with initial data.
 * @param {import('../services/types.js').Highlight[]} highlights 
 * @param {object} options 
 */
function render(highlights, options = {}) {
  _options = options;
  _createPanel();
  _renderContent(highlights);
}

function open() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.add('anyllm-hl-open');
}

function close() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.remove('anyllm-hl-open');
}

function toggle() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.toggle('anyllm-hl-open');
  else console.warn('[AnyLLM] HighlightsPanel not rendered yet.');
}

function destroy() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
}

/**
 * Optimistically add a highlight.
 */
function addHighlight(hl) {
  // Rather than fully re-rendering, just re-fetch all active from memory if we had an internal store.
  // We'll trust the parent to call render(newHighlights) for simplicity.
  // In a real reactive app we'd mutate state here.
}

const HighlightsPanel = Object.freeze({
  render, open, close, toggle, destroy, addHighlight
});

export default HighlightsPanel;
export { render, open, close, toggle, destroy, addHighlight };
