// src/components/ContextSidePanel.js
// AnyLLM — Context Side Panel (P2.2)
//
// Injects a collapsible side panel into the host LLM page (Claude / ChatGPT /
// Gemini) to display the extracted context. Renders without any framework — pure
// DOM manipulation so it works in any content-script environment.
//
// Public API:
//   ContextSidePanel.render(extractedContext)  — create / update the panel
//   ContextSidePanel.open()                    — show the panel
//   ContextSidePanel.close()                   — hide the panel
//   ContextSidePanel.toggle()                  — toggle visibility
//   ContextSidePanel.destroy()                 — remove from DOM entirely

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_ID        = 'anyllm-context-panel';
const TOGGLE_BTN_ID   = 'anyllm-context-toggle-btn';
const OVERLAY_ID      = 'anyllm-context-overlay';
const STYLE_ID        = 'anyllm-context-styles';

const PANEL_WIDTH     = '400px';
const Z_INDEX         = '2147483640'; // Near-max; above most host-page elements

// Platform display names
const PLATFORM_LABELS = {
  claude:   '🟣 Claude.ai',
  chatgpt:  '🟢 ChatGPT',
  gemini:   '🔵 Google Gemini',
  unknown:  '❓ Unknown',
};

// ── Styles ────────────────────────────────────────────────────────────────────

/**
 * Build the CSS string for all injected elements.
 * Uses a unique prefix `anyllm-` on every class / ID to avoid conflicts with the
 * host page's stylesheet.
 *
 * @returns {string}
 */
function buildStyles() {
  return `
/* ── AnyLLM Context Panel — Injected Styles ── */

#${PANEL_ID} {
  position: fixed;
  top: 0;
  right: 0;
  width: ${PANEL_WIDTH};
  height: 100vh;
  background: linear-gradient(160deg, #0f1117 0%, #141824 100%);
  color: #e2e8f0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  line-height: 1.6;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 32px rgba(0, 0, 0, 0.6);
  border-left: 1px solid rgba(99, 102, 241, 0.25);
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

#${PANEL_ID}.anyllm-panel-open {
  transform: translateX(0);
}

/* ── Header ── */
.anyllm-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px;
  background: rgba(99, 102, 241, 0.08);
  border-bottom: 1px solid rgba(99, 102, 241, 0.2);
  flex-shrink: 0;
}

.anyllm-panel-title {
  font-size: 14px;
  font-weight: 700;
  color: #a5b4fc;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.anyllm-panel-title .anyllm-logo-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #818cf8, #34d399);
  box-shadow: 0 0 6px rgba(129, 140, 248, 0.6);
  animation: anyllm-pulse 2.5s ease-in-out infinite;
}

@keyframes anyllm-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.6; transform: scale(0.85); }
}

.anyllm-panel-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.anyllm-icon-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
  display: flex;
  align-items: center;
}
.anyllm-icon-btn:hover { background: rgba(99,102,241,0.15); color: #e2e8f0; }

/* ── Metadata row ── */
.anyllm-meta-row {
  padding: 8px 16px;
  background: rgba(15, 17, 23, 0.5);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: #64748b;
  flex-shrink: 0;
}

.anyllm-meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(99,102,241,0.1);
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 999px;
  padding: 2px 9px;
  color: #818cf8;
  font-weight: 500;
  font-size: 10.5px;
}

/* ── Tab bar ── */
.anyllm-tab-bar {
  display: flex;
  background: rgba(15,17,23,0.7);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}

.anyllm-tab-btn {
  flex: 1;
  padding: 9px 4px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #64748b;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  text-align: center;
}
.anyllm-tab-btn:hover { color: #94a3b8; }
.anyllm-tab-btn.anyllm-active {
  color: #818cf8;
  border-bottom-color: #818cf8;
}

/* ── Scrollable body ── */
.anyllm-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(99,102,241,0.3) transparent;
}
.anyllm-panel-body::-webkit-scrollbar { width: 5px; }
.anyllm-panel-body::-webkit-scrollbar-thumb {
  background: rgba(99,102,241,0.35);
  border-radius: 999px;
}

/* ── Tab content panes ── */
.anyllm-tab-pane { display: none; padding: 14px 16px; }
.anyllm-tab-pane.anyllm-active { display: block; }

/* ── Section headings ── */
.anyllm-section-heading {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #4b5563;
  margin: 14px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.anyllm-section-heading:first-child { margin-top: 0; }

/* ── Empty state ── */
.anyllm-empty {
  text-align: center;
  color: #374151;
  padding: 28px 16px;
  font-size: 12px;
}

/* ── Topics pills ── */
.anyllm-topics-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.anyllm-topic-pill {
  background: rgba(52, 211, 153, 0.1);
  border: 1px solid rgba(52, 211, 153, 0.2);
  color: #34d399;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  cursor: default;
}

/* ── Decision / Next-step cards ── */
.anyllm-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  font-size: 12.5px;
  line-height: 1.55;
  position: relative;
  transition: border-color 0.15s;
}
.anyllm-card:hover { border-color: rgba(99,102,241,0.3); }

.anyllm-card-role {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  margin-bottom: 4px;
}
.anyllm-card-role.user { color: #60a5fa; }
.anyllm-card-role.assistant { color: #a78bfa; }
.anyllm-card-role.unknown { color: #94a3b8; }

.anyllm-decision-card { border-left: 3px solid rgba(251, 191, 36, 0.5); }
.anyllm-nextstep-card  { border-left: 3px solid rgba(52, 211, 153, 0.5); }

/* ── Code block cards ── */
.anyllm-code-card {
  background: rgba(15,17,23,0.9);
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 8px;
  margin-bottom: 10px;
  overflow: hidden;
}

.anyllm-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(99,102,241,0.08);
  border-bottom: 1px solid rgba(99,102,241,0.15);
}

.anyllm-code-lang {
  font-size: 10.5px;
  font-weight: 600;
  color: #818cf8;
  text-transform: lowercase;
}

.anyllm-copy-btn {
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}
.anyllm-copy-btn:hover { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.anyllm-copy-btn.anyllm-copied { color: #34d399; }

.anyllm-code-body {
  padding: 10px 12px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: #cbd5e1;
  white-space: pre;
  overflow-x: auto;
  max-height: 240px;
  scrollbar-width: thin;
  scrollbar-color: rgba(99,102,241,0.3) transparent;
}

/* ── Handoff prompt textarea ── */
.anyllm-handoff-area {
  width: 100%;
  min-height: 220px;
  background: rgba(15,17,23,0.9);
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 8px;
  color: #cbd5e1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 10px 12px;
  resize: vertical;
  line-height: 1.55;
  outline: none;
  transition: border-color 0.15s;
}
.anyllm-handoff-area:focus { border-color: rgba(99,102,241,0.5); }

.anyllm-handoff-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.anyllm-action-btn {
  flex: 1;
  min-width: 90px;
  padding: 8px 12px;
  border: 1px solid;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}
.anyllm-action-btn.primary {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  border-color: transparent;
  color: #fff;
}
.anyllm-action-btn.primary:hover {
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  transform: translateY(-1px);
}
.anyllm-action-btn.secondary {
  background: transparent;
  border-color: rgba(99,102,241,0.35);
  color: #818cf8;
}
.anyllm-action-btn.secondary:hover {
  background: rgba(99,102,241,0.1);
  transform: translateY(-1px);
}
.anyllm-action-btn.success { background: rgba(52,211,153,0.15); border-color: rgba(52,211,153,0.35); color: #34d399; }

/* ── Condensed timeline ── */
.anyllm-timeline-msg {
  border-left: 2px solid rgba(255,255,255,0.06);
  margin-bottom: 10px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #94a3b8;
  border-radius: 0 6px 6px 0;
  transition: border-color 0.15s;
}
.anyllm-timeline-msg.verbatim {
  border-left-color: rgba(99,102,241,0.4);
  color: #e2e8f0;
  background: rgba(99,102,241,0.04);
}
.anyllm-timeline-msg.user { border-left-color: rgba(96,165,250,0.4); }
.anyllm-timeline-msg.verbatim.user { background: rgba(96,165,250,0.04); }
.anyllm-timeline-msg.assistant { border-left-color: rgba(167,139,250,0.4); }
.anyllm-timeline-msg.verbatim.assistant { background: rgba(167,139,250,0.04); }

.anyllm-tl-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  margin-bottom: 3px;
}
.anyllm-timeline-msg.user .anyllm-tl-label { color: #60a5fa; }
.anyllm-timeline-msg.assistant .anyllm-tl-label { color: #a78bfa; }
.anyllm-timeline-msg.unknown .anyllm-tl-label { color: #64748b; }

.anyllm-verbatim-badge {
  font-size: 9px;
  background: rgba(99,102,241,0.2);
  color: #818cf8;
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 6px;
  font-weight: 600;
}

/* ── Floating toggle button ── */
#${TOGGLE_BTN_ID} {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: ${Number(Z_INDEX) - 1};
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  border: none;
  border-radius: 10px 0 0 10px;
  padding: 12px 8px;
  cursor: pointer;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  box-shadow: -2px 0 16px rgba(99,102,241,0.4);
  transition: padding 0.2s, background 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
}
#${TOGGLE_BTN_ID}:hover {
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  padding-right: 12px;
}

/* ── Footer ── */
.anyllm-panel-footer {
  flex-shrink: 0;
  padding: 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: #374151;
}

.anyllm-refresh-btn {
  background: none;
  border: 1px solid rgba(99,102,241,0.25);
  color: #6366f1;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.anyllm-refresh-btn:hover { background: rgba(99,102,241,0.1); }
`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** @returns {HTMLElement | null} */
const getPanel = () => document.getElementById(PANEL_ID);

/** Escape HTML special characters to prevent XSS from message content */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function activateTab(panel, tabId) {
  panel.querySelectorAll('.anyllm-tab-btn').forEach(btn => {
    btn.classList.toggle('anyllm-active', btn.dataset.tab === tabId);
  });
  panel.querySelectorAll('.anyllm-tab-pane').forEach(pane => {
    pane.classList.toggle('anyllm-active', pane.dataset.pane === tabId);
  });
}

// ── Content renderers ─────────────────────────────────────────────────────────

/**
 * Render the "Summary" tab pane.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function renderSummaryTab(ctx) {
  const timestamp = new Date(ctx.extractedAt).toLocaleTimeString();
  const topicPills = ctx.topics.length
    ? ctx.topics.map(t => `<span class="anyllm-topic-pill">${esc(t)}</span>`).join('')
    : '<span class="anyllm-empty">No topics detected.</span>';

  return `
    <p class="anyllm-section-heading">Topics & Entities</p>
    <div class="anyllm-topics-wrap">${topicPills}</div>

    <p class="anyllm-section-heading">Stats</p>
    <div class="anyllm-meta-row" style="padding:0; border:none; background:none; gap:8px; flex-direction:column;">
      <div>💬 <strong>${ctx.totalMessages}</strong> total messages
        (<span style="color:#60a5fa">${ctx.userCount} user</span>,
         <span style="color:#a78bfa">${ctx.assistantCount} assistant</span>)
      </div>
      <div>🧠 <strong>${ctx.decisions.length}</strong> key decisions detected</div>
      <div>➡️ <strong>${ctx.nextSteps.length}</strong> next steps detected</div>
      <div>🖥️ <strong>${ctx.codeBlocks.length}</strong> code blocks extracted</div>
      <div style="color:#374151; font-size:11px; margin-top:4px;">Extracted at ${esc(timestamp)}</div>
    </div>
  `;
}

/**
 * Render the "Decisions" tab pane.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function renderDecisionsTab(ctx) {
  if (ctx.decisions.length === 0) {
    return `<div class="anyllm-empty">No decisions or conclusions detected in this conversation.</div>`;
  }

  const cards = ctx.decisions.map(d => `
    <div class="anyllm-card anyllm-decision-card">
      <div class="anyllm-card-role ${esc(d.role)}">${esc(d.role)}</div>
      <div>${esc(d.sentence)}</div>
    </div>
  `).join('');

  const steps = ctx.nextSteps.length === 0 ? '' : `
    <p class="anyllm-section-heading">Next Steps</p>
    ${ctx.nextSteps.map(s => `
      <div class="anyllm-card anyllm-nextstep-card">
        <div class="anyllm-card-role ${esc(s.role)}">${esc(s.role)}</div>
        <div>${esc(s.sentence)}</div>
      </div>
    `).join('')}
  `;

  return `
    <p class="anyllm-section-heading">Key Decisions (${ctx.decisions.length})</p>
    ${cards}
    ${steps}
  `;
}

/**
 * Render the "Code" tab pane.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function renderCodeTab(ctx) {
  if (ctx.codeBlocks.length === 0) {
    return `<div class="anyllm-empty">No fenced code blocks detected in this conversation.</div>`;
  }

  return ctx.codeBlocks.map((block, idx) => `
    <div class="anyllm-code-card" data-block-idx="${idx}">
      <div class="anyllm-code-header">
        <span class="anyllm-code-lang">${esc(block.language || 'plaintext')}</span>
        <button class="anyllm-copy-btn" data-copy-idx="${idx}" title="Copy code">📋 Copy</button>
      </div>
      <pre class="anyllm-code-body">${esc(block.code)}</pre>
    </div>
  `).join('');
}

/**
 * Render the "Timeline" tab pane.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function renderTimelineTab(ctx) {
  if (ctx.condensed.length === 0) {
    return `<div class="anyllm-empty">No messages to display.</div>`;
  }

  return ctx.condensed.map(msg => {
    const roleClass = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'unknown';
    const badge = msg.verbatim
      ? `<span class="anyllm-verbatim-badge">VERBATIM</span>`
      : '';
    return `
      <div class="anyllm-timeline-msg ${roleClass} ${msg.verbatim ? 'verbatim' : ''}">
        <div class="anyllm-tl-label">${esc(msg.role.toUpperCase())}${badge}</div>
        <div>${esc(msg.text)}</div>
      </div>
    `;
  }).join('');
}

/**
 * Render the "Handoff" tab pane.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function renderHandoffTab(ctx) {
  return `
    <p class="anyllm-section-heading">Structured Handoff Prompt</p>
    <p style="font-size:11.5px; color:#64748b; margin-bottom:10px;">
      This prompt packages your conversation context for seamless transfer to another LLM session.
      Copy it and paste it into a new chat to continue without losing context.
    </p>
    <textarea
      id="anyllm-handoff-textarea"
      class="anyllm-handoff-area"
      readonly
    >${esc(ctx.handoffPrompt)}</textarea>
    <div class="anyllm-handoff-actions">
      <button class="anyllm-action-btn primary" id="anyllm-copy-handoff">📋 Copy Prompt</button>
      <button class="anyllm-action-btn secondary" id="anyllm-open-claude">Open Claude</button>
      <button class="anyllm-action-btn secondary" id="anyllm-open-chatgpt">Open ChatGPT</button>
      <button class="anyllm-action-btn secondary" id="anyllm-open-gemini">Open Gemini</button>
    </div>
  `;
}

// ── Panel builder ─────────────────────────────────────────────────────────────

/**
 * Build the full panel HTML string.
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 * @returns {string}
 */
function buildPanelHTML(ctx) {
  const platformLabel = PLATFORM_LABELS[ctx.platform] || PLATFORM_LABELS.unknown;

  return `
    <div class="anyllm-panel-header">
      <div class="anyllm-panel-title">
        <span class="anyllm-logo-dot"></span>
        AnyLLM Context
      </div>
      <div class="anyllm-panel-actions">
        <button class="anyllm-icon-btn" id="anyllm-close-btn" title="Close panel">✕</button>
      </div>
    </div>

    <div class="anyllm-meta-row">
      <span class="anyllm-meta-chip">${esc(platformLabel)}</span>
      <span class="anyllm-meta-chip">💬 ${ctx.totalMessages} msgs</span>
      <span class="anyllm-meta-chip">🧠 ${ctx.decisions.length} decisions</span>
    </div>

    <div class="anyllm-tab-bar">
      <button class="anyllm-tab-btn anyllm-active" data-tab="summary">Summary</button>
      <button class="anyllm-tab-btn" data-tab="decisions">Decisions</button>
      <button class="anyllm-tab-btn" data-tab="code">Code (${ctx.codeBlocks.length})</button>
      <button class="anyllm-tab-btn" data-tab="timeline">Timeline</button>
      <button class="anyllm-tab-btn" data-tab="handoff">Handoff</button>
    </div>

    <div class="anyllm-panel-body">
      <div class="anyllm-tab-pane anyllm-active" data-pane="summary">${renderSummaryTab(ctx)}</div>
      <div class="anyllm-tab-pane" data-pane="decisions">${renderDecisionsTab(ctx)}</div>
      <div class="anyllm-tab-pane" data-pane="code">${renderCodeTab(ctx)}</div>
      <div class="anyllm-tab-pane" data-pane="timeline">${renderTimelineTab(ctx)}</div>
      <div class="anyllm-tab-pane" data-pane="handoff">${renderHandoffTab(ctx)}</div>
    </div>

    <div class="anyllm-panel-footer">
      <span>AnyLLM v1.1.0</span>
      <button class="anyllm-refresh-btn" id="anyllm-refresh-btn">↻ Refresh</button>
    </div>
  `;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

/** @type {import('../services/contextExtractor.js').ExtractedContext | null} */
let _lastContext = null;

/** @type {Function | null} callback invoked when Refresh is clicked */
let _onRefresh = null;

/**
 * Wire all interactive elements inside the panel.
 * @param {HTMLElement} panel
 * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
 */
function wireEvents(panel, ctx) {
  // Tab switching
  panel.querySelectorAll('.anyllm-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(panel, btn.dataset.tab));
  });

  // Close button
  panel.querySelector('#anyllm-close-btn')?.addEventListener('click', () => ContextSidePanel.close());

  // Refresh button
  panel.querySelector('#anyllm-refresh-btn')?.addEventListener('click', () => {
    if (typeof _onRefresh === 'function') _onRefresh();
  });

  // Copy individual code blocks
  panel.querySelectorAll('.anyllm-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.copyIdx);
      const block = ctx.codeBlocks[idx];
      if (!block) return;
      navigator.clipboard.writeText(block.code).then(() => {
        btn.textContent = '✅ Copied';
        btn.classList.add('anyllm-copied');
        setTimeout(() => {
          btn.textContent = '📋 Copy';
          btn.classList.remove('anyllm-copied');
        }, 1800);
      });
    });
  });

  // Copy handoff prompt
  panel.querySelector('#anyllm-copy-handoff')?.addEventListener('click', () => {
    const btn = panel.querySelector('#anyllm-copy-handoff');
    navigator.clipboard.writeText(ctx.handoffPrompt).then(() => {
      if (btn) {
        btn.textContent = '✅ Copied!';
        btn.classList.add('success');
        setTimeout(() => {
          btn.textContent = '📋 Copy Prompt';
          btn.classList.remove('success');
        }, 2000);
      }
    });
  });

  // Open target platform
  const platformUrls = {
    '#anyllm-open-claude':   'https://claude.ai/new',
    '#anyllm-open-chatgpt':  'https://chatgpt.com/',
    '#anyllm-open-gemini':   'https://gemini.google.com/',
  };
  for (const [selector, url] of Object.entries(platformUrls)) {
    panel.querySelector(selector)?.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'ANYLLM_OPEN_URL',
        url,
      });
    });
  }
}

// ── Public API object ─────────────────────────────────────────────────────────

const ContextSidePanel = {
  /**
   * Create or update the side panel with new extracted context.
   *
   * @param {import('../services/contextExtractor.js').ExtractedContext} ctx
   * @param {{ onRefresh?: Function }} [options]
   */
  render(ctx, { onRefresh } = {}) {
    _lastContext = ctx;
    _onRefresh = onRefresh || null;

    // Inject styles (once)
    if (!document.getElementById(STYLE_ID)) {
      const styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = buildStyles();
      document.head.appendChild(styleEl);
    }

    // Create or reuse panel element
    let panel = getPanel();
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'complementary');
      panel.setAttribute('aria-label', 'AnyLLM Context Panel');
      document.body.appendChild(panel);
    }

    panel.innerHTML = buildPanelHTML(ctx);
    wireEvents(panel, ctx);

    // Create floating toggle button (once)
    if (!document.getElementById(TOGGLE_BTN_ID)) {
      const toggleBtn = document.createElement('button');
      toggleBtn.id = TOGGLE_BTN_ID;
      toggleBtn.title = 'Toggle AnyLLM Context Panel';
      toggleBtn.innerHTML = '✦ AnyLLM';
      toggleBtn.addEventListener('click', () => ContextSidePanel.toggle());
      document.body.appendChild(toggleBtn);
    }
  },

  /** Show the panel. */
  open() {
    const panel = getPanel();
    if (panel) panel.classList.add('anyllm-panel-open');
  },

  /** Hide the panel. */
  close() {
    const panel = getPanel();
    if (panel) panel.classList.remove('anyllm-panel-open');
  },

  /** Toggle open/closed state. */
  toggle() {
    const panel = getPanel();
    if (panel) panel.classList.toggle('anyllm-panel-open');
  },

  /** Remove the panel and its toggle button from the DOM entirely. */
  destroy() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(TOGGLE_BTN_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    _lastContext = null;
  },

  /** True if the panel currently exists in the DOM. */
  get isRendered() {
    return !!getPanel();
  },

  /** True if the panel is visible (open). */
  get isOpen() {
    return !!getPanel()?.classList.contains('anyllm-panel-open');
  },
};

export default ContextSidePanel;
export { ContextSidePanel };
