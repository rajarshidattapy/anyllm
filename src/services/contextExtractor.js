// src/services/contextExtractor.js
// AnyLLM — Context Extractor Service (P2.2)
//
// Analyses an array of { messageId, role, text } message objects from a
// platform adapter and produces a rich ExtractedContext result.
//
// Analysis passes (in order):
//   1. Code block extraction  — fenced (```) and inline (`) via regex
//   2. Decision detection     — keyword / phrase patterns on each sentence
//   3. Next-step detection    — "next:", "step N", "todo:" etc.
//   4. Entity / topic mining  — capitalised noun phrases & domain keywords
//   5. Condensed summary      — recent N messages verbatim + older ones truncated
//   6. Handoff prompt package — structured template ready for P2.7

'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * How many of the most-recent messages to keep verbatim in the summary.
 * Older messages are truncated to their last meaningful sentence.
 */
const RECENT_VERBATIM_COUNT = 6;

/**
 * Maximum characters to keep from an older (non-verbatim) message.
 */
const TRUNCATE_LENGTH = 300;

/**
 * Maximum characters allowed per code block in the handoff template.
 * Longer blocks are trimmed with a notice.
 */
const MAX_CODE_BLOCK_CHARS = 1500;

// ── Pattern banks ─────────────────────────────────────────────────────────────

/**
 * Patterns that signal a decision or conclusion was reached.
 * Tested against individual sentences inside assistant messages.
 */
const DECISION_PATTERNS = [
  /\b(let'?s (go with|use|do)|we('ll| will) (use|build|implement))\b/i,
  /\b(final(ly)?|conclusion|decided|agreed|confirmed)\b/i,
  /\b(the (answer|solution|fix) is)\b/i,
  /\b(we('ve| have) (chosen|settled on|opted for))\b/i,
  /\b(best (approach|option|choice|practice) (is|would be))\b/i,
  /\b(recommend(ed)?|suggest(ed)?) (using|going with|to)\b/i,
  /\b(this (means|implies|confirms))\b/i,
  /\b(so (the plan is|we('ll| will)))\b/i,
];

/**
 * Patterns that signal an upcoming action or next step.
 */
const NEXT_STEP_PATTERNS = [
  /\b(next[,:]|now (let'?s|we)|step \d+|todo[:\s])\b/i,
  /\b(you (need|should|can) (now|next))\b/i,
  /\b(after (this|that)|then (we|you))\b/i,
  /\b(first[,\s]|second[,\s]|third[,\s]|finally[,\s])\b/i,
  /\b(the next (step|thing|task) (is|to))\b/i,
  /\b(go ahead and|proceed to|start (by|with))\b/i,
  /\b(run|execute|install|create|add|update|modify|deploy)\b/i,
];

/**
 * Regex for code blocks:
 *   - Fenced:  ```lang\n...\n``` (multiline, non-greedy)
 *   - Inline:  `code`
 *
 * The `g` flag is required; callers must reset lastIndex between uses.
 */
const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`\n]+`/g;

/**
 * Regex for stripping markdown code blocks from text before sentence splitting.
 */
const CODE_BLOCK_STRIP_REGEX = /```[\s\S]*?```|`[^`\n]+`/g;

/**
 * Domain-level keywords worth surfacing as topics even without capitalisation.
 */
const DOMAIN_KEYWORDS = [
  'api', 'database', 'backend', 'frontend', 'server', 'client',
  'authentication', 'authorisation', 'authorization', 'deployment',
  'docker', 'kubernetes', 'lambda', 'function', 'endpoint', 'schema',
  'migration', 'refactor', 'testing', 'typescript', 'javascript',
  'python', 'rust', 'react', 'vue', 'angular', 'sql', 'nosql',
  'graphql', 'rest', 'grpc', 'oauth', 'jwt', 'redis', 'postgres',
  'mongo', 'webpack', 'vite', 'ci', 'cd', 'pipeline',
];

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Split text into sentences using simple punctuation heuristics.
 * Keeps sentences that contain at least one word character.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  // Strip code blocks first so we don't confuse code punctuation with sentences
  const stripped = text.replace(CODE_BLOCK_STRIP_REGEX, '');
  return stripped
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => /\w/.test(s));
}

/**
 * Truncate a message to at most `maxChars` characters, appending "…" if cut.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars = TRUNCATE_LENGTH) {
  if (text.length <= maxChars) return text;
  // Try to break at last sentence boundary within the limit
  const sub = text.slice(0, maxChars);
  const lastPeriod = Math.max(sub.lastIndexOf('. '), sub.lastIndexOf('.\n'));
  return (lastPeriod > maxChars * 0.5 ? sub.slice(0, lastPeriod + 1) : sub) + '…';
}

/**
 * Extract all code blocks (fenced + inline) from a text string.
 * Returns an array of { raw, language, code } objects.
 *
 * @param {string} text
 * @returns {Array<{ raw: string, language: string, code: string }>}
 */
function extractCodeBlocks(text) {
  const blocks = [];
  // Reset regex state before each call
  const re = new RegExp(CODE_BLOCK_REGEX.source, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    if (raw.startsWith('```')) {
      // Fenced block — extract optional language tag
      const inner = raw.slice(3, -3).trimStart();
      const firstNewline = inner.indexOf('\n');
      const language = firstNewline > 0 ? inner.slice(0, firstNewline).trim() : '';
      const code = firstNewline > 0 ? inner.slice(firstNewline + 1) : inner;
      blocks.push({ raw, language, code: code.trim() });
    } else {
      // Inline code
      const code = raw.slice(1, -1);
      blocks.push({ raw, language: 'inline', code });
    }
  }
  return blocks;
}

/**
 * Mine topics and entities from text.
 * Heuristics used:
 *   - Capitalised phrases of 1–3 words not at start of sentence
 *   - Domain keyword list matches
 *
 * Returns a de-duplicated array, sorted by frequency (most common first).
 *
 * @param {string[]} texts   — array of message texts
 * @returns {string[]}
 */
function mineTopics(texts) {
  /** @type {Map<string, number>} */
  const freq = new Map();

  const bump = (token) => {
    const key = token.toLowerCase();
    freq.set(key, (freq.get(key) || 0) + 1);
  };

  for (const text of texts) {
    const stripped = text.replace(CODE_BLOCK_STRIP_REGEX, ' ');

    // 1. Domain keyword hits
    for (const kw of DOMAIN_KEYWORDS) {
      const re = new RegExp(`\\b${kw}\\b`, 'gi');
      const hits = (stripped.match(re) || []).length;
      if (hits > 0) {
        const existing = freq.get(kw) || 0;
        freq.set(kw, existing + hits);
      }
    }

    // 2. Capitalised noun phrases (2+ capital-letter-started words in a row)
    // Skip the very first word of each sentence to reduce noise
    const sentences = splitSentences(stripped);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        // Check if this word and the next are both capitalised
        const w = words[i].replace(/[^a-zA-Z]/g, '');
        if (w.length < 2) continue;
        if (/^[A-Z][a-z]/.test(w)) {
          // Build a phrase with up to 2 following words
          let phrase = w;
          for (let j = 1; j <= 2 && i + j < words.length; j++) {
            const next = words[i + j].replace(/[^a-zA-Z]/g, '');
            if (/^[A-Z][a-z]/.test(next) && next.length > 1) {
              phrase += ' ' + next;
            } else break;
          }
          bump(phrase);
        }
      }
    }
  }

  // Sort by frequency, deduplicate, keep top 15
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 1)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([key]) => key);
}

// ── Core analysis passes ──────────────────────────────────────────────────────

/**
 * Scan all messages and collect:
 *   - Decisions (sentences matching DECISION_PATTERNS)
 *   - Next steps (sentences matching NEXT_STEP_PATTERNS)
 *   - Code blocks (from assistant messages)
 *
 * @param {Array<{ messageId: string, role: string, text: string }>} messages
 * @returns {{
 *   decisions: Array<{ sentence: string, messageId: string, role: string }>,
 *   nextSteps:  Array<{ sentence: string, messageId: string, role: string }>,
 *   codeBlocks: Array<{ raw: string, language: string, code: string, messageId: string }>
 * }}
 */
function analyseMessages(messages) {
  const decisions = [];
  const nextSteps = [];
  const codeBlocks = [];

  for (const msg of messages) {
    const { messageId, role, text } = msg;

    // ── Code blocks (all roles, but mostly assistant) ──────────────────────
    const blocks = extractCodeBlocks(text);
    for (const block of blocks) {
      // Only collect fenced blocks (not inline snippets) to avoid noise
      if (block.language !== 'inline') {
        codeBlocks.push({ ...block, messageId });
      }
    }

    // ── Sentence-level pattern matching ────────────────────────────────────
    const sentences = splitSentences(text);

    for (const sentence of sentences) {
      const isDecision = DECISION_PATTERNS.some(p => p.test(sentence));
      const isNextStep = NEXT_STEP_PATTERNS.some(p => p.test(sentence));

      if (isDecision) {
        decisions.push({ sentence: sentence.trim(), messageId, role });
      }
      if (isNextStep) {
        nextSteps.push({ sentence: sentence.trim(), messageId, role });
      }
    }
  }

  // Deduplicate decisions / next steps by sentence text
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter(({ sentence }) => {
      if (seen.has(sentence)) return false;
      seen.add(sentence);
      return true;
    });
  };

  return {
    decisions: dedupe(decisions),
    nextSteps:  dedupe(nextSteps),
    codeBlocks,
  };
}

/**
 * Build the condensed message summary:
 *   - The last RECENT_VERBATIM_COUNT messages are kept in full.
 *   - Older messages are truncated to their last meaningful sentence.
 *
 * @param {Array<{ messageId: string, role: string, text: string }>} messages
 * @returns {Array<{ messageId: string, role: string, text: string, verbatim: boolean }>}
 */
function condenseMessages(messages) {
  const cutoff = Math.max(0, messages.length - RECENT_VERBATIM_COUNT);
  return messages.map((msg, idx) => {
    if (idx >= cutoff) {
      return { ...msg, verbatim: true };
    }
    return {
      ...msg,
      text: truncate(msg.text, TRUNCATE_LENGTH),
      verbatim: false,
    };
  });
}

// ── Handoff template builder ──────────────────────────────────────────────────

/**
 * Package the extracted context into the structured handoff prompt.
 *
 * Sections:
 *   [SYSTEM PREAMBLE]
 *   [CONTEXT SUMMARY]
 *   [KEY DECISIONS]
 *   [CODE]
 *   [NEXT STEPS]
 *   [RECENT EXCHANGE]
 *   [CONFIRMATION REQUEST]
 *
 * @param {ExtractedContext} ctx
 * @returns {string}
 */
function buildHandoffPrompt(ctx) {
  const hr = '─'.repeat(60);
  const lines = [];

  lines.push('You are continuing a conversation that was transferred from another AI assistant.');
  lines.push('Below is a structured summary. Read it carefully before responding.');
  lines.push('');
  lines.push(hr);

  // ── Context Summary ───────────────────────────────────────────────────────
  lines.push('[CONTEXT SUMMARY]');
  lines.push(`Platform  : ${ctx.platform}`);
  lines.push(`Messages  : ${ctx.totalMessages} total (${ctx.assistantCount} assistant, ${ctx.userCount} user)`);
  if (ctx.topics.length > 0) {
    lines.push(`Topics    : ${ctx.topics.join(', ')}`);
  }
  lines.push('');

  // ── Key Decisions ─────────────────────────────────────────────────────────
  if (ctx.decisions.length > 0) {
    lines.push(hr);
    lines.push('[KEY DECISIONS]');
    for (const d of ctx.decisions.slice(0, 10)) {
      lines.push(`• [${d.role.toUpperCase()}] ${d.sentence}`);
    }
    lines.push('');
  }

  // ── Code ──────────────────────────────────────────────────────────────────
  if (ctx.codeBlocks.length > 0) {
    lines.push(hr);
    lines.push('[CODE]');
    for (const block of ctx.codeBlocks.slice(0, 5)) {
      const langTag = block.language ? block.language : '';
      const codeBody = block.code.length > MAX_CODE_BLOCK_CHARS
        ? block.code.slice(0, MAX_CODE_BLOCK_CHARS) + '\n… [truncated]'
        : block.code;
      lines.push('```' + langTag);
      lines.push(codeBody);
      lines.push('```');
      lines.push('');
    }
  }

  // ── Next Steps ────────────────────────────────────────────────────────────
  if (ctx.nextSteps.length > 0) {
    lines.push(hr);
    lines.push('[NEXT STEPS]');
    for (const s of ctx.nextSteps.slice(0, 8)) {
      lines.push(`→ [${s.role.toUpperCase()}] ${s.sentence}`);
    }
    lines.push('');
  }

  // ── Recent Exchange ───────────────────────────────────────────────────────
  lines.push(hr);
  lines.push('[RECENT EXCHANGE]');
  const recent = ctx.condensed.filter(m => m.verbatim);
  for (const msg of recent) {
    const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
    lines.push(`\n[${label}]`);
    lines.push(msg.text);
  }
  lines.push('');

  // ── Confirmation Request ──────────────────────────────────────────────────
  lines.push(hr);
  lines.push('[CONFIRMATION REQUEST]');
  lines.push('Please confirm you have understood the above context by briefly summarising:');
  lines.push('1. The main topic/goal of this conversation.');
  lines.push('2. Any key decisions already made.');
  lines.push('3. The next step you will help with.');
  lines.push('');
  lines.push('Then proceed with the continuation.');

  return lines.join('\n');
}

// ── Main public API ───────────────────────────────────────────────────────────

/**
 * @typedef {object} ExtractedContext
 * @property {string}   platform          - 'claude' | 'chatgpt' | 'gemini' | 'unknown'
 * @property {string}   conversationId
 * @property {number}   totalMessages
 * @property {number}   userCount
 * @property {number}   assistantCount
 * @property {string[]} topics            - Mined keyword topics
 * @property {Array<{ sentence: string, messageId: string, role: string }>} decisions
 * @property {Array<{ sentence: string, messageId: string, role: string }>} nextSteps
 * @property {Array<{ raw: string, language: string, code: string, messageId: string }>} codeBlocks
 * @property {Array<{ messageId: string, role: string, text: string, verbatim: boolean }>} condensed
 * @property {string}   handoffPrompt     - Fully formatted handoff template
 * @property {number}   extractedAt       - Unix ms timestamp
 */

/**
 * Extract rich context from a set of messages returned by a platform adapter.
 *
 * @param {import('../adapters/adapter.js').PlatformAdapter} adapter
 * @returns {ExtractedContext | null}  null if no messages found
 */
function extractContext(adapter) {
  const elements = adapter.getMessageElements();

  if (elements.length === 0) {
    console.warn('[AnyLLM][ContextExtractor] No message elements found.');
    return null;
  }

  // Collect structured message data from adapter
  const messages = elements
    .map((el, idx) => adapter.extractMessageData(el, idx))
    .filter(Boolean)                              // drop null extractions
    .filter(msg => msg.text && msg.text.trim()); // drop empty messages

  if (messages.length === 0) {
    console.warn('[AnyLLM][ContextExtractor] Messages found but text extraction yielded nothing.');
    return null;
  }

  const platform = adapter.getPlatformIdentifier();
  const conversationId = adapter.getConversationId();

  const userCount = messages.filter(m => m.role === 'user').length;
  const assistantCount = messages.filter(m => m.role === 'assistant').length;

  // Run analysis passes
  const { decisions, nextSteps, codeBlocks } = analyseMessages(messages);
  const condensed = condenseMessages(messages);
  const topics = mineTopics(messages.map(m => m.text));

  /** @type {ExtractedContext} */
  const ctx = {
    platform,
    conversationId,
    totalMessages: messages.length,
    userCount,
    assistantCount,
    topics,
    decisions,
    nextSteps,
    codeBlocks,
    condensed,
    handoffPrompt: '', // filled below
    extractedAt: Date.now(),
  };

  ctx.handoffPrompt = buildHandoffPrompt(ctx);

  console.log(
    `[AnyLLM][ContextExtractor] Extracted context from ${messages.length} messages. ` +
    `Decisions: ${decisions.length}, Next steps: ${nextSteps.length}, ` +
    `Code blocks: ${codeBlocks.length}, Topics: ${topics.slice(0, 5).join(', ')}`
  );

  return ctx;
}

// ── Named exports ─────────────────────────────────────────────────────────────

export {
  extractContext,
  buildHandoffPrompt,
  condenseMessages,
  analyseMessages,
  extractCodeBlocks,
  mineTopics,
  splitSentences,
  // Constants — useful for testing and P2.7 handoff service
  RECENT_VERBATIM_COUNT,
  TRUNCATE_LENGTH,
  DECISION_PATTERNS,
  NEXT_STEP_PATTERNS,
  CODE_BLOCK_REGEX,
};

export default { extractContext };
