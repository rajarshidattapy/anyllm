// src/services/pinService.js
// AnyLLM — Pin Service (P2.3)
//
// Handles all create / read / update / delete operations for pinned messages.
// Data is persisted via StorageService (P1.3) under the namespace:
//   anyllm::<platform>::<conversationId>::pin
//
// Public API:
//   pinMessage(messageData)              — pin a message; returns the new Pin
//   unpinMessage(pinId, platform, cid)  — remove a pin by ID
//   getPins(platform, conversationId)   — load all pins for a conversation
//   getAllPins()                         — load every pin across all conversations
//   reorderPins(platform, cid, pinIds)  — persist a new drag-drop order
//   isPinned(messageId, platform, cid)  — fast check without loading whole list
//   onPinsChanged(cb)                   — subscribe to pin changes
//   offPinsChanged(cb)                  — unsubscribe

'use strict';

import {
  DATA_TYPES,
  createPin,
  appendToCollection,
  getCollection,
  removeFromCollection,
  setCollection,
  getAll,
} from './storage.js';

// ── Change listeners ──────────────────────────────────────────────────────────

/** @type {Set<Function>} */
const _listeners = new Set();

/**
 * Notify all subscribers that pins changed.
 * @param {string} event  — 'pinned' | 'unpinned' | 'reordered'
 * @param {object} detail
 */
function _notify(event, detail) {
  _listeners.forEach(cb => {
    try { cb(event, detail); } catch (e) {
      console.error('[AnyLLM][PinService] Listener error:', e);
    }
  });
}

/**
 * Subscribe to pin-change events.
 * @param {Function} cb  — (event: string, detail: object) => void
 */
function onPinsChanged(cb) {
  _listeners.add(cb);
}

/**
 * Unsubscribe from pin-change events.
 * @param {Function} cb
 */
function offPinsChanged(cb) {
  _listeners.delete(cb);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Pin a message.
 *
 * @param {{
 *   messageId:      string,
 *   platform:       string,
 *   conversationId: string,
 *   role:           'user' | 'assistant' | 'unknown',
 *   text:           string,
 * }} messageData
 * @returns {Promise<import('./types.js').Pin>}
 */
async function pinMessage(messageData) {
  const { messageId, platform, conversationId, role, text } = messageData;

  // Assign order = current count so new pins go to the bottom
  const existing = await getCollection(platform, conversationId, DATA_TYPES.PIN);
  const order = existing.length;

  const pin = createPin({ platform, conversationId, messageId, role, text, order });

  const ok = await appendToCollection(platform, conversationId, DATA_TYPES.PIN, pin);
  if (!ok) {
    throw new Error(`[AnyLLM][PinService] Failed to save pin for message ${messageId}`);
  }

  console.log(`[AnyLLM][PinService] Pinned message ${messageId} (order ${order})`);
  _notify('pinned', { pin });
  return pin;
}

/**
 * Unpin a message by pin ID.
 *
 * @param {string} pinId
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
async function unpinMessage(pinId, platform, conversationId) {
  const ok = await removeFromCollection(platform, conversationId, DATA_TYPES.PIN, pinId);
  if (ok) {
    console.log(`[AnyLLM][PinService] Unpinned pin ${pinId}`);
    _notify('unpinned', { pinId, platform, conversationId });
  }
  return ok;
}

/**
 * Load all pins for a specific conversation, sorted by `order`.
 *
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<import('./types.js').Pin[]>}
 */
async function getPins(platform, conversationId) {
  const pins = await getCollection(platform, conversationId, DATA_TYPES.PIN);
  return [...pins].sort((a, b) => a.order - b.order);
}

/**
 * Load ALL pins across every platform and conversation.
 * Groups them by platform › conversationId for easy rendering.
 *
 * @returns {Promise<import('./types.js').Pin[]>}
 */
async function getAllPins() {
  const all = await getAll();
  const pins = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('anyllm::') || !key.endsWith(`::${DATA_TYPES.PIN}`)) continue;
    if (Array.isArray(value)) {
      pins.push(...value);
    }
  }
  return pins.sort((a, b) => a.order - b.order);
}

/**
 * Check whether a specific message is already pinned in this conversation.
 *
 * @param {string} messageId
 * @param {string} platform
 * @param {string} conversationId
 * @returns {Promise<import('./types.js').Pin | null>}  — the Pin if found, null otherwise
 */
async function isPinned(messageId, platform, conversationId) {
  const pins = await getCollection(platform, conversationId, DATA_TYPES.PIN);
  return pins.find(p => p.messageId === messageId) || null;
}

/**
 * Persist a new display order after drag-and-drop.
 * `orderedPinIds` must be the full list of pin IDs in the desired order.
 *
 * @param {string}   platform
 * @param {string}   conversationId
 * @param {string[]} orderedPinIds
 * @returns {Promise<boolean>}
 */
async function reorderPins(platform, conversationId, orderedPinIds) {
  const pins = await getCollection(platform, conversationId, DATA_TYPES.PIN);

  // Build an ID→pin map for fast lookup
  const pinMap = new Map(pins.map(p => [p.id, p]));

  const reordered = orderedPinIds
    .map((id, idx) => {
      const pin = pinMap.get(id);
      if (!pin) return null;
      return { ...pin, order: idx };
    })
    .filter(Boolean);

  const ok = await setCollection(platform, conversationId, DATA_TYPES.PIN, reordered);
  if (ok) {
    _notify('reordered', { platform, conversationId, orderedPinIds });
  }
  return ok;
}

// ── Public API ────────────────────────────────────────────────────────────────

const PinService = Object.freeze({
  pinMessage,
  unpinMessage,
  getPins,
  getAllPins,
  isPinned,
  reorderPins,
  onPinsChanged,
  offPinsChanged,
});

export default PinService;
export {
  pinMessage,
  unpinMessage,
  getPins,
  getAllPins,
  isPinned,
  reorderPins,
  onPinsChanged,
  offPinsChanged,
};
