// src/services/storage.js
// AnyLLM Storage Service
//
// Wraps chrome.storage.local with:
//  - Namespaced keys per platform + conversation + type
//  - Typed data model schemas for all features
//  - Storage quota monitoring and LRU eviction (2 MB budget)
//  - Promise-based API with full try/catch error handling

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** chrome.storage.local hard limit is 10 MB; we self-impose 2 MB */
const QUOTA_BYTES = 2 * 1024 * 1024; // 2 MB
const QUOTA_WARN_THRESHOLD = 0.80;   // warn at 80 % full
const QUOTA_EVICT_THRESHOLD = 0.90;  // evict LRU entries at 90 % full

/** Recognised data type identifiers used in namespace keys */
const DATA_TYPES = Object.freeze({
  PIN: 'pin',
  HIGHLIGHT: 'highlight',
  EDIT: 'edit',
  DELETED: 'deleted',
  HANDOFF: 'handoff',
  META: 'meta',
});

/** Recognised platform identifiers */
const PLATFORMS = Object.freeze({
  CLAUDE: 'claude',
  CHATGPT: 'chatgpt',
  UNKNOWN: 'unknown',
});

// ─── Namespace helpers ────────────────────────────────────────────────────────

/**
 * Build a deterministic storage key for a given platform / conversation / type.
 *
 * Format: `anyllm::<platform>::<conversationId>::<type>`
 *
 * @param {string} platform       - One of PLATFORMS values.
 * @param {string} conversationId - Unique ID for the conversation thread.
 * @param {string} type           - One of DATA_TYPES values.
 * @returns {string}
 */
function getNamespaceKey(platform, conversationId, type) {
  if (!platform || !conversationId || !type) {
    throw new Error(
      `[AnyLLM][Storage] getNamespaceKey: all arguments are required. ` +
      `Received: platform="${platform}", conversationId="${conversationId}", type="${type}"`
    );
  }
  return `anyllm::${platform}::${conversationId}::${type}`;
}

/**
 * Parse a namespace key back into its components.
 * Returns null if the key does not follow the AnyLLM format.
 *
 * @param {string} key
 * @returns {{ platform: string, conversationId: string, type: string } | null}
 */
function parseNamespaceKey(key) {
  if (!key || !key.startsWith('anyllm::')) return null;
  const parts = key.split('::');
  if (parts.length !== 4) return null;
  const [, platform, conversationId, type] = parts;
  return { platform, conversationId, type };
}

// ─── Core CRUD helpers ────────────────────────────────────────────────────────

/**
 * Read a value from chrome.storage.local.
 * Returns undefined if the key does not exist.
 *
 * @template T
 * @param {string} key
 * @returns {Promise<T | undefined>}
 */
async function get(key) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key];
  } catch (err) {
    console.error('[AnyLLM][Storage] get() failed for key:', key, err);
    return undefined;
  }
}

/**
 * Write a value to chrome.storage.local.
 * Automatically attaches an `_updatedAt` timestamp to objects.
 *
 * @param {string} key
 * @param {*} value
 * @returns {Promise<boolean>} true on success
 */
async function set(key, value) {
  try {
    // Stamp objects with a last-updated timestamp for LRU eviction
    const stored = (value !== null && typeof value === 'object' && !Array.isArray(value))
      ? { ...value, _updatedAt: Date.now() }
      : value;

    await chrome.storage.local.set({ [key]: stored });
    return true;
  } catch (err) {
    console.error('[AnyLLM][Storage] set() failed for key:', key, err);
    return false;
  }
}

/**
 * Remove one or more keys from chrome.storage.local.
 *
 * @param {string | string[]} keys
 * @returns {Promise<boolean>} true on success
 */
async function remove(keys) {
  try {
    await chrome.storage.local.remove(keys);
    return true;
  } catch (err) {
    console.error('[AnyLLM][Storage] remove() failed for keys:', keys, err);
    return false;
  }
}

/**
 * Read ALL keys from chrome.storage.local.
 * Use sparingly — returns the entire store.
 *
 * @returns {Promise<Record<string, *>>}
 */
async function getAll() {
  try {
    return await chrome.storage.local.get(null);
  } catch (err) {
    console.error('[AnyLLM][Storage] getAll() failed:', err);
    return {};
  }
}

/**
 * Clear every key belonging to AnyLLM (prefix `anyllm::`).
 * Leaves unrelated extension storage untouched.
 *
 * @returns {Promise<void>}
 */
async function clearAll() {
  try {
    const all = await getAll();
    const anyllmKeys = Object.keys(all).filter(k => k.startsWith('anyllm::'));
    if (anyllmKeys.length) await chrome.storage.local.remove(anyllmKeys);
    console.log('[AnyLLM][Storage] Cleared all AnyLLM data:', anyllmKeys.length, 'keys.');
  } catch (err) {
    console.error('[AnyLLM][Storage] clearAll() failed:', err);
  }
}

// ─── Quota Management ─────────────────────────────────────────────────────────

/**
 * Check current chrome.storage.local usage against the self-imposed 2 MB quota.
 * Logs a warning if > 80 % full.
 * Automatically evicts LRU (least recently used) AnyLLM entries if > 90 % full.
 *
 * @returns {Promise<{ usedBytes: number, quotaBytes: number, usedPercent: number }>}
 */
async function checkStorageQuota() {
  try {
    const usedBytes = await chrome.storage.local.getBytesInUse(null);
    const usedPercent = usedBytes / QUOTA_BYTES;

    if (usedPercent >= QUOTA_EVICT_THRESHOLD) {
      console.warn(
        `[AnyLLM][Storage] ⚠ Storage at ${(usedPercent * 100).toFixed(1)}% of ${QUOTA_BYTES / 1024} KB budget. ` +
        `Evicting LRU entries…`
      );
      await _evictLRU();
    } else if (usedPercent >= QUOTA_WARN_THRESHOLD) {
      console.warn(
        `[AnyLLM][Storage] ⚠ Storage at ${(usedPercent * 100).toFixed(1)}% of ${QUOTA_BYTES / 1024} KB budget.`
      );
    } else {
      console.log(
        `[AnyLLM][Storage] Storage OK: ${(usedBytes / 1024).toFixed(1)} KB / ${QUOTA_BYTES / 1024} KB ` +
        `(${(usedPercent * 100).toFixed(1)}% used).`
      );
    }

    return { usedBytes, quotaBytes: QUOTA_BYTES, usedPercent };
  } catch (err) {
    console.error('[AnyLLM][Storage] checkStorageQuota() failed:', err);
    return { usedBytes: 0, quotaBytes: QUOTA_BYTES, usedPercent: 0 };
  }
}

/**
 * Evict the oldest AnyLLM entries until usage drops below the eviction threshold.
 * Entries are sorted by their `_updatedAt` timestamp (oldest first).
 *
 * @private
 * @returns {Promise<void>}
 */
async function _evictLRU() {
  try {
    const all = await getAll();

    // Collect only AnyLLM entries that carry a timestamp
    const candidates = Object.entries(all)
      .filter(([key, val]) =>
        key.startsWith('anyllm::') &&
        val !== null &&
        typeof val === 'object' &&
        typeof val._updatedAt === 'number'
      )
      .sort(([, a], [, b]) => a._updatedAt - b._updatedAt); // oldest first

    let removed = 0;
    for (const [key] of candidates) {
      await remove(key);
      removed++;

      const usedBytes = await chrome.storage.local.getBytesInUse(null);
      if (usedBytes / QUOTA_BYTES < QUOTA_EVICT_THRESHOLD) break;
    }

    console.log(`[AnyLLM][Storage] Evicted ${removed} LRU entries.`);
  } catch (err) {
    console.error('[AnyLLM][Storage] _evictLRU() failed:', err);
  }
}

// ─── Data Model Factories ─────────────────────────────────────────────────────
//
// Each factory returns a plain-object matching the schema for that feature.
// All timestamps are Unix ms (Date.now()).
//
// ─── Schema: Pin ───────────────────────────────────────────────────────────────
//
// {
//   id:             string   — unique identifier (crypto.randomUUID or timestamp-based)
//   platform:       string   — 'claude' | 'chatgpt'
//   conversationId: string   — ID of the parent conversation
//   messageId:      string   — DOM-derived ID of the pinned message
//   role:           string   — 'user' | 'assistant'
//   text:           string   — full plain-text content of the message
//   pinnedAt:       number   — Unix ms when the pin was created
//   order:          number   — display order (0 = top); supports drag-drop reorder
//   _updatedAt:     number   — auto-set by set(); used for LRU eviction
// }

/**
 * Create a new Pin data object.
 *
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {'user'|'assistant'} params.role
 * @param {string} params.text
 * @param {number} [params.order]
 * @returns {import('./types').Pin}
 */
function createPin({ platform, conversationId, messageId, role, text, order = 0 }) {
  return {
    id: _generateId(),
    platform,
    conversationId,
    messageId,
    role,
    text,
    pinnedAt: Date.now(),
    order,
  };
}

// ─── Schema: Highlight ─────────────────────────────────────────────────────────
//
// {
//   id:             string
//   platform:       string
//   conversationId: string
//   messageId:      string
//   text:           string   — the highlighted text snippet
//   color:          string   — 'yellow' | 'green' | 'red'
//   xpath:          string   — XPath to the text node for re-anchoring on page reload
//   textOffset:     number   — character offset within the text node
//   createdAt:      number
//   _updatedAt:     number
// }

/**
 * Create a new Highlight data object.
 *
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string} params.text
 * @param {'yellow'|'green'|'red'} params.color
 * @param {string} [params.xpath]
 * @param {number} [params.textOffset]
 * @returns {import('./types').Highlight}
 */
function createHighlight({
  platform,
  conversationId,
  messageId,
  text,
  color,
  startPath = '',
  startOffset = 0,
  endPath = '',
  endOffset = 0,
}) {
  return {
    id: _generateId(),
    platform,
    conversationId,
    messageId,
    text,
    color,
    startPath,
    startOffset,
    endPath,
    endOffset,
    createdAt: Date.now(),
  };
}

// ─── Schema: Edit ──────────────────────────────────────────────────────────────
//
// {
//   id:             string
//   platform:       string
//   conversationId: string
//   messageId:      string
//   originalText:   string   — verbatim original AI response text
//   editedText:     string   — user's replacement text
//   editedAt:       number
//   _updatedAt:     number
// }

/**
 * Create a new Edit data object.
 *
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string} params.originalText
 * @param {string} params.editedText
 * @returns {import('./types').Edit}
 */
function createEdit({ platform, conversationId, messageId, originalText, editedText }) {
  return {
    id: _generateId(),
    platform,
    conversationId,
    messageId,
    originalText,
    editedText,
    editedAt: Date.now(),
  };
}

// ─── Schema: DeletedMessage ───────────────────────────────────────────────────
//
// {
//   id:             string
//   platform:       string
//   conversationId: string
//   messageId:      string   — DOM-derived ID used to match message on page reload
//   deletedAt:      number
//   _updatedAt:     number
// }

/**
 * Create a new DeletedMessage data object.
 *
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @returns {import('./types').DeletedMessage}
 */
function createDeletedMessage({ platform, conversationId, messageId }) {
  return {
    id: _generateId(),
    platform,
    conversationId,
    messageId,
    deletedAt: Date.now(),
  };
}

// ─── Schema: HandoffPrompt ────────────────────────────────────────────────────
//
// {
//   id:             string
//   sourcePlatform: string   — platform the handoff was initiated from
//   targetPlatform: string   — intended destination platform
//   conversationId: string
//   promptText:     string   — full structured handoff prompt string
//   createdAt:      number
//   deliveredVia:   string   — 'new_tab' | 'clipboard' | 'pinboard' | 'pending'
//   _updatedAt:     number
// }

/**
 * Create a new HandoffPrompt data object.
 *
 * @param {object} params
 * @param {string} params.sourcePlatform
 * @param {string} params.targetPlatform
 * @param {string} params.conversationId
 * @param {string} params.promptText
 * @param {'new_tab'|'clipboard'|'pinboard'|'pending'} [params.deliveredVia]
 * @returns {import('./types').HandoffPrompt}
 */
function createHandoffPrompt({
  sourcePlatform,
  targetPlatform,
  conversationId,
  promptText,
  deliveredVia = 'pending',
}) {
  return {
    id: _generateId(),
    sourcePlatform,
    targetPlatform,
    conversationId,
    promptText,
    createdAt: Date.now(),
    deliveredVia,
  };
}

// ─── Feature-level Convenience Wrappers ──────────────────────────────────────
//
// Higher-level helpers used by individual feature services.
// They handle key construction, serialisation, and collection management.

/**
 * Append an item to a stored array under a namespace key.
 * Creates the array if it does not yet exist.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @param {string} type           - One of DATA_TYPES values
 * @param {object} item           - Item to append (must have a unique `.id`)
 * @returns {Promise<boolean>}
 */
async function appendToCollection(platform, conversationId, type, item) {
  const key = getNamespaceKey(platform, conversationId, type);
  const existing = (await get(key)) || [];
  existing.push(item);
  const ok = await set(key, existing);
  if (ok) await checkStorageQuota();
  return ok;
}

/**
 * Read an entire collection from storage.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @param {string} type
 * @returns {Promise<Array>}
 */
async function getCollection(platform, conversationId, type) {
  const key = getNamespaceKey(platform, conversationId, type);
  return (await get(key)) || [];
}

/**
 * Update a single item inside a stored collection by its `.id`.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @param {string} type
 * @param {string} itemId
 * @param {Partial<object>} updates  - Fields to merge into the item
 * @returns {Promise<boolean>}
 */
async function updateInCollection(platform, conversationId, type, itemId, updates) {
  const key = getNamespaceKey(platform, conversationId, type);
  const collection = (await get(key)) || [];
  const idx = collection.findIndex(item => item.id === itemId);
  if (idx === -1) {
    console.warn(`[AnyLLM][Storage] Item ${itemId} not found in ${key}`);
    return false;
  }
  collection[idx] = { ...collection[idx], ...updates };
  return set(key, collection);
}

/**
 * Remove a single item from a stored collection by its `.id`.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @param {string} type
 * @param {string} itemId
 * @returns {Promise<boolean>}
 */
async function removeFromCollection(platform, conversationId, type, itemId) {
  const key = getNamespaceKey(platform, conversationId, type);
  const collection = (await get(key)) || [];
  const filtered = collection.filter(item => item.id !== itemId);
  if (filtered.length === collection.length) {
    console.warn(`[AnyLLM][Storage] Item ${itemId} not found in ${key}`);
    return false;
  }
  return set(key, filtered);
}

/**
 * Replace the entire collection under a namespace key.
 * Useful for bulk operations (e.g. drag-drop reorder of pins).
 *
 * @param {string} platform
 * @param {string} conversationId
 * @param {string} type
 * @param {Array}  collection
 * @returns {Promise<boolean>}
 */
async function setCollection(platform, conversationId, type, collection) {
  const key = getNamespaceKey(platform, conversationId, type);
  return set(key, collection);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Generate a short unique ID.
 * Uses crypto.randomUUID when available, falls back to timestamp + random suffix.
 *
 * @private
 * @returns {string}
 */
function _generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const StorageService = Object.freeze({
  // Constants
  DATA_TYPES,
  PLATFORMS,
  QUOTA_BYTES,

  // Namespace
  getNamespaceKey,
  parseNamespaceKey,

  // Core CRUD
  get,
  set,
  remove,
  getAll,
  clearAll,

  // Quota
  checkStorageQuota,

  // Data model factories
  createPin,
  createHighlight,
  createEdit,
  createDeletedMessage,
  createHandoffPrompt,

  // Collection helpers
  appendToCollection,
  getCollection,
  updateInCollection,
  removeFromCollection,
  setCollection,
});

export default StorageService;

// Named exports for convenience in feature modules
export {
  DATA_TYPES,
  PLATFORMS,
  getNamespaceKey,
  parseNamespaceKey,
  get,
  set,
  remove,
  getAll,
  clearAll,
  checkStorageQuota,
  createPin,
  createHighlight,
  createEdit,
  createDeletedMessage,
  createHandoffPrompt,
  appendToCollection,
  getCollection,
  updateInCollection,
  removeFromCollection,
  setCollection,
};
