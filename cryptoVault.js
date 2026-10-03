const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_DIR = path.join(__dirname, 'data');
const KEY_FILE = path.join(KEY_DIR, '.server_vault.key');

let cachedKey = null;

/**
 * Retrieves or initializes the 256-bit server encryption key.
 * Priority:
 * 1. process.env.SERVER_ENCRYPTION_KEY (if provided)
 * 2. Persisted local key file (data/.server_vault.key)
 * 3. Freshly generated 256-bit key saved to data/.server_vault.key
 */
function getServerKey() {
  if (cachedKey) return cachedKey;

  if (process.env.SERVER_ENCRYPTION_KEY) {
    const rawKey = process.env.SERVER_ENCRYPTION_KEY.trim();
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      cachedKey = Buffer.from(rawKey, 'hex');
    } else {
      cachedKey = crypto.createHash('sha256').update(rawKey).digest();
    }
    return cachedKey;
  }

  try {
    if (!fs.existsSync(KEY_DIR)) {
      fs.mkdirSync(KEY_DIR, { recursive: true });
    }

    if (fs.existsSync(KEY_FILE)) {
      const keyBuffer = fs.readFileSync(KEY_FILE);
      if (keyBuffer.length === 32) {
        cachedKey = keyBuffer;
        return cachedKey;
      }
    }

    // Generate fresh 32-byte (256-bit) key
    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, newKey, { mode: 0o600 });
    cachedKey = newKey;
    return cachedKey;
  } catch (err) {
    console.error('[CryptoVault] Failed to persist server key, falling back to process-memory key:', err.message);
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }
}

/**
 * Returns a short 8-character fingerprint of the active key for diagnostics
 */
function getKeyFingerprint() {
  const key = getServerKey();
  return crypto.createHash('sha256').update(key).digest('hex').substring(0, 8);
}

/**
 * Encrypts an object or string with server-side AES-256-GCM
 * @param {any} data Plaintext object, array, or string
 * @returns {{ iv: string, authTag: string, ciphertext: string, version: number }}
 */
function encryptEnvelope(data) {
  const key = getServerKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(jsonStr, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext,
    createdAt: Date.now()
  };
}

/**
 * Decrypts an AES-256-GCM encrypted envelope
 * @param {{ iv: string, authTag: string, ciphertext: string }} envelope
 * @returns {any} Original parsed data
 */
function decryptEnvelope(envelope) {
  if (!envelope || !envelope.iv || !envelope.authTag || !envelope.ciphertext) {
    throw new Error('Invalid encryption envelope structure');
  }

  const key = getServerKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(envelope.ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  try {
    return JSON.parse(decrypted);
  } catch {
    return decrypted;
  }
}

module.exports = {
  encryptEnvelope,
  decryptEnvelope,
  getKeyFingerprint,
  getServerKey
};
