const fs = require('fs');
const path = require('path');
const cryptoVault = require('./cryptoVault');
const { normalizePhone, phonesMatch } = require('./phoneUtils');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'offline_vault.json');
const TMP_FILE = path.join(DATA_DIR, 'offline_vault.tmp');

class OfflineStore {
  constructor() {
    this.messages = [];
    this.statuses = [];
    this.reactions = [];
    this.initialized = false;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.messages = Array.isArray(data.messages) ? data.messages : [];
        this.statuses = Array.isArray(data.statuses) ? data.statuses : [];
        this.reactions = Array.isArray(data.reactions) ? data.reactions : [];
        console.log(`[OfflineStore] Loaded encrypted store: ${this.messages.length} messages, ${this.statuses.length} status receipts, ${this.reactions.length} reactions pending`);
      } else {
        this.save();
      }
      this.initialized = true;
    } catch (err) {
      console.error('[OfflineStore] Failed to initialize store, starting with empty state:', err.message);
      this.messages = [];
      this.statuses = [];
      this.reactions = [];
      this.initialized = true;
    }
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const payload = {
        version: 1,
        lastUpdated: Date.now(),
        messages: this.messages,
        statuses: this.statuses,
        reactions: this.reactions
      };

      const jsonStr = JSON.stringify(payload, null, 2);
      fs.writeFileSync(TMP_FILE, jsonStr, 'utf8');
      fs.renameSync(TMP_FILE, STORE_FILE);
    } catch (err) {
      console.error('[OfflineStore] Error saving store to disk:', err.message);
    }
  }

  /**
   * Encrypts and holds a relay message for a recipient until delivery is confirmed.
   * Prevents premature flushing so messages survive offline periods and server restarts.
   */
  enqueueMessage(recipientMobile, relayPayload, targetDeviceIds = null) {
    try {
      const cleanMobile = normalizePhone(recipientMobile);
      const msgId = relayPayload.id || `msg_${Date.now()}`;

      // Avoid duplicate enqueue if already in vault
      const existingIdx = this.messages.findIndex(m => m.id === msgId);
      if (existingIdx >= 0) {
        return true;
      }

      const envelope = cryptoVault.encryptEnvelope(relayPayload);
      const record = {
        id: msgId,
        recipient: cleanMobile,
        rawRecipient: recipientMobile,
        sender: relayPayload.sender || '',
        timestamp: relayPayload.timestamp || Date.now(),
        pendingDeviceIds: Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0 ? [...targetDeviceIds] : null,
        delivered: false,
        deliveredAt: null,
        envelope
      };

      this.messages.push(record);
      this.save();
      console.log(`[OfflineStore] Encrypted & stored offline message ${record.id} for ${cleanMobile} (devices: ${record.pendingDeviceIds ? record.pendingDeviceIds.join(',') : 'all'})`);
      return true;
    } catch (err) {
      console.error('[OfflineStore] Failed to enqueue message:', err.message);
      return false;
    }
  }

  /**
   * Retrieves and decrypts pending messages for a recipient without deleting them.
   * Messages remain safely held in the encrypted vault until delivery is confirmed.
   */
  getPendingMessages(recipientMobile, deviceId = null) {
    const toDeliver = [];

    for (const record of this.messages) {
      if (record.delivered) continue;

      const isMatch = phonesMatch(record.recipient, recipientMobile) ||
                      (record.rawRecipient && phonesMatch(record.rawRecipient, recipientMobile));

      if (isMatch) {
        let shouldDeliver = false;
        if (!deviceId || deviceId === 'default' || !record.pendingDeviceIds) {
          shouldDeliver = true;
        } else if (record.pendingDeviceIds.includes(deviceId)) {
          shouldDeliver = true;
        }

        if (shouldDeliver) {
          try {
            const decryptedPayload = cryptoVault.decryptEnvelope(record.envelope);
            toDeliver.push(decryptedPayload);
          } catch (err) {
            console.error(`[OfflineStore] Decryption failed for message ${record.id}:`, err.message);
          }
        }
      }
    }

    if (toDeliver.length > 0) {
      console.log(`[OfflineStore] Retrieved ${toDeliver.length} pending vault messages for ${recipientMobile} (device: ${deviceId || 'any'})`);
    }

    return toDeliver;
  }

  /**
   * Confirms delivery of a message to the recipient's device.
   * Only after the recipient phone confirms delivery is the message safely purged from the vault.
   */
  acknowledgeDelivery(messageId, deviceId = null) {
    let removed = false;
    const remaining = [];

    for (const record of this.messages) {
      if (record.id === messageId) {
        if (record.pendingDeviceIds && deviceId && record.pendingDeviceIds.length > 1) {
          record.pendingDeviceIds = record.pendingDeviceIds.filter(id => id !== deviceId);
          remaining.push(record);
        } else {
          removed = true;
        }
      } else {
        remaining.push(record);
      }
    }

    if (removed) {
      this.messages = remaining;
      this.save();
      console.log(`[OfflineStore] Confirmed delivery of message ${messageId}. Safely purged from vault.`);
    }

    return removed;
  }

  /**
   * Checks if a message is currently pending in the offline vault
   */
  hasPendingMessage(messageId) {
    return this.messages.some(m => m.id === messageId && !m.delivered);
  }

  /**
   * Backward-compatible alias for retrieving pending messages
   */
  dequeueMessages(recipientMobile, deviceId = null) {
    return this.getPendingMessages(recipientMobile, deviceId);
  }

  /**
   * Encrypts and holds a status update (delivery/read receipt) for an offline target
   */
  enqueueStatus(targetMobile, statusPayload, targetDeviceIds = null) {
    try {
      const cleanMobile = normalizePhone(targetMobile);
      const envelope = cryptoVault.encryptEnvelope(statusPayload);
      const record = {
        target: cleanMobile,
        rawTarget: targetMobile,
        timestamp: Date.now(),
        pendingDeviceIds: Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0 ? [...targetDeviceIds] : null,
        envelope
      };

      this.statuses.push(record);
      this.save();
      return true;
    } catch (err) {
      console.error('[OfflineStore] Failed to enqueue status:', err.message);
      return false;
    }
  }

  /**
   * Retrieves, decrypts, and removes pending status updates for a target device
   */
  dequeueStatuses(targetMobile, deviceId = null) {
    const toDeliver = [];
    const remaining = [];

    for (const record of this.statuses) {
      const isMatch = phonesMatch(record.target, targetMobile) ||
                      (record.rawTarget && phonesMatch(record.rawTarget, targetMobile));

      if (isMatch) {
        let shouldDeliver = false;
        if (!deviceId || deviceId === 'default' || !record.pendingDeviceIds) {
          shouldDeliver = true;
          record.pendingDeviceIds = null;
        } else if (record.pendingDeviceIds.includes(deviceId)) {
          shouldDeliver = true;
          record.pendingDeviceIds = record.pendingDeviceIds.filter(id => id !== deviceId);
        }

        if (shouldDeliver) {
          try {
            const decryptedPayload = cryptoVault.decryptEnvelope(record.envelope);
            toDeliver.push(decryptedPayload);
          } catch (err) {
            console.error(`[OfflineStore] Decryption failed for status record:`, err.message);
          }
        }

        if (record.pendingDeviceIds && record.pendingDeviceIds.length > 0) {
          remaining.push(record);
        }
      } else {
        remaining.push(record);
      }
    }

    if (toDeliver.length > 0 || remaining.length !== this.statuses.length) {
      this.statuses = remaining;
      this.save();
    }

    return toDeliver;
  }

  /**
   * Encrypts and holds a reaction update for an offline target
   */
  enqueueReaction(targetMobile, reactionPayload, targetDeviceIds = null) {
    try {
      const cleanMobile = normalizePhone(targetMobile);
      const envelope = cryptoVault.encryptEnvelope(reactionPayload);
      const record = {
        target: cleanMobile,
        rawTarget: targetMobile,
        timestamp: Date.now(),
        pendingDeviceIds: Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0 ? [...targetDeviceIds] : null,
        envelope
      };

      this.reactions.push(record);
      this.save();
      console.log(`[OfflineStore] Encrypted & queued offline reaction for ${cleanMobile} (msg ${reactionPayload.id}: ${reactionPayload.reaction})`);
      return true;
    } catch (err) {
      console.error('[OfflineStore] Failed to enqueue reaction:', err.message);
      return false;
    }
  }

  /**
   * Retrieves, decrypts, and removes pending reactions for a target device
   */
  dequeueReactions(targetMobile, deviceId = null) {
    const toDeliver = [];
    const remaining = [];

    for (const record of this.reactions) {
      const isMatch = phonesMatch(record.target, targetMobile) ||
                      (record.rawTarget && phonesMatch(record.rawTarget, targetMobile));

      if (isMatch) {
        let shouldDeliver = false;
        if (!deviceId || deviceId === 'default' || !record.pendingDeviceIds) {
          shouldDeliver = true;
          record.pendingDeviceIds = null;
        } else if (record.pendingDeviceIds.includes(deviceId)) {
          shouldDeliver = true;
          record.pendingDeviceIds = record.pendingDeviceIds.filter(id => id !== deviceId);
        }

        if (shouldDeliver) {
          try {
            const decryptedPayload = cryptoVault.decryptEnvelope(record.envelope);
            toDeliver.push(decryptedPayload);
          } catch (err) {
            console.error(`[OfflineStore] Decryption failed for reaction record:`, err.message);
          }
        }

        if (record.pendingDeviceIds && record.pendingDeviceIds.length > 0) {
          remaining.push(record);
        }
      } else {
        remaining.push(record);
      }
    }

    if (toDeliver.length > 0 || remaining.length !== this.reactions.length) {
      this.reactions = remaining;
      this.save();
    }

    return toDeliver;
  }

  getStats() {
    const uniqueRecipients = new Set(this.messages.map(m => m.recipient));
    return {
      pendingMessagesCount: this.messages.length,
      pendingStatusesCount: this.statuses.length,
      pendingReactionsCount: this.reactions.length,
      pendingRecipientsCount: uniqueRecipients.size
    };
  }

  getPendingOverview() {
    return {
      messages: this.messages.map(m => ({
        id: m.id,
        recipient: m.recipient,
        rawRecipient: m.rawRecipient,
        sender: m.sender,
        timestamp: m.timestamp
      })),
      statuses: this.statuses.map(s => ({
        target: s.target,
        rawTarget: s.rawTarget,
        timestamp: s.timestamp
      })),
      reactions: this.reactions.map(r => ({
        target: r.target,
        rawTarget: r.rawTarget,
        timestamp: r.timestamp
      }))
    };
  }

  clearAll() {
    this.messages = [];
    this.statuses = [];
    this.reactions = [];
    this.save();
  }
}

module.exports = new OfflineStore();
