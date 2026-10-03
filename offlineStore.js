const fs = require('fs');
const path = require('path');
const cryptoVault = require('./cryptoVault');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'offline_vault.json');
const TMP_FILE = path.join(DATA_DIR, 'offline_vault.tmp');

class OfflineStore {
  constructor() {
    this.messages = [];
    this.statuses = [];
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
        console.log(`[OfflineStore] Loaded encrypted store: ${this.messages.length} messages, ${this.statuses.length} status receipts pending`);
      } else {
        this.save();
      }
      this.initialized = true;
    } catch (err) {
      console.error('[OfflineStore] Failed to initialize store, starting with empty state:', err.message);
      this.messages = [];
      this.statuses = [];
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
        statuses: this.statuses
      };

      const jsonStr = JSON.stringify(payload, null, 2);
      fs.writeFileSync(TMP_FILE, jsonStr, 'utf8');
      fs.renameSync(TMP_FILE, STORE_FILE);
    } catch (err) {
      console.error('[OfflineStore] Error saving store to disk:', err.message);
    }
  }

  /**
   * Encrypts and holds a relay message for an offline recipient
   */
  enqueueMessage(recipientMobile, relayPayload) {
    try {
      const envelope = cryptoVault.encryptEnvelope(relayPayload);
      const record = {
        id: relayPayload.id || `msg_${Date.now()}`,
        recipient: recipientMobile,
        sender: relayPayload.sender || '',
        timestamp: relayPayload.timestamp || Date.now(),
        envelope
      };

      this.messages.push(record);
      this.save();
      console.log(`[OfflineStore] Encrypted & queued offline message ${record.id} for ${recipientMobile}`);
      return true;
    } catch (err) {
      console.error('[OfflineStore] Failed to enqueue message:', err.message);
      return false;
    }
  }

  /**
   * Retrieves, decrypts, and removes all pending messages for a recipient
   */
  dequeueMessages(recipientMobile) {
    const toDeliver = [];
    const remaining = [];

    for (const record of this.messages) {
      if (record.recipient === recipientMobile) {
        try {
          const decryptedPayload = cryptoVault.decryptEnvelope(record.envelope);
          toDeliver.push(decryptedPayload);
        } catch (err) {
          console.error(`[OfflineStore] Decryption failed for message ${record.id}:`, err.message);
        }
      } else {
        remaining.push(record);
      }
    }

    if (toDeliver.length > 0) {
      this.messages = remaining;
      this.save();
      console.log(`[OfflineStore] Dequeued & decrypted ${toDeliver.length} offline messages for ${recipientMobile}`);
    }

    return toDeliver;
  }

  /**
   * Encrypts and holds a status update (delivery/read receipt) for an offline target
   */
  enqueueStatus(targetMobile, statusPayload) {
    try {
      const envelope = cryptoVault.encryptEnvelope(statusPayload);
      const record = {
        target: targetMobile,
        timestamp: Date.now(),
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
   * Retrieves, decrypts, and removes all pending status updates for a target
   */
  dequeueStatuses(targetMobile) {
    const toDeliver = [];
    const remaining = [];

    for (const record of this.statuses) {
      if (record.target === targetMobile) {
        try {
          const decryptedPayload = cryptoVault.decryptEnvelope(record.envelope);
          toDeliver.push(decryptedPayload);
        } catch (err) {
          console.error(`[OfflineStore] Decryption failed for status record:`, err.message);
        }
      } else {
        remaining.push(record);
      }
    }

    if (toDeliver.length > 0) {
      this.statuses = remaining;
      this.save();
    }

    return toDeliver;
  }

  getStats() {
    const uniqueRecipients = new Set(this.messages.map(m => m.recipient));
    return {
      pendingMessagesCount: this.messages.length,
      pendingStatusesCount: this.statuses.length,
      pendingRecipientsCount: uniqueRecipients.size
    };
  }

  clearAll() {
    this.messages = [];
    this.statuses = [];
    this.save();
  }
}

module.exports = new OfflineStore();
