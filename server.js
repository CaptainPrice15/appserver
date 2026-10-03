const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const cryptoVault = require('./cryptoVault');
const offlineStore = require('./offlineStore');

const app = express();
app.use(cors());
app.use(express.json());

// Render sets PORT automatically (e.g., 10000); default to 8080 locally
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Normalizes phone numbers to standard format (digits and optional leading +)
function normalizePhone(phone) {
  if (!phone) return '';
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

// Memory stores
const activeClients = new Map(); // mobile -> { ws, nickname, lastSeen }
const registeredUsers = new Map(); // mobile -> { mobile, nickname, registeredAt }

// REST Endpoints
app.get('/', (req, res) => {
  const host = req.headers.host || 'localhost:8080';
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${host}`;
  const vaultStats = offlineStore.getStats();

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stealth Chat Server - Live</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: #0f111a; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .container { background: #1a1c29; border: 1px solid #282c3f; border-radius: 16px; padding: 32px; max-width: 540px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 700; color: #fff; }
    .status-badge { background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #10b981; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
    .desc { color: #9ca3af; font-size: 14px; line-height: 1.5; margin-bottom: 20px; }
    .security-banner { background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 10px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; color: #c7d2fe; display: flex; justify-content: space-between; align-items: center; }
    .sec-tag { background: #4f46e5; color: #fff; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #6366f1; font-weight: 700; margin-bottom: 8px; }
    .url-box { background: #12131e; border: 1px solid #2d314d; border-radius: 10px; padding: 14px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; word-break: break-all; }
    .url-text { font-family: monospace; font-size: 14px; color: #818cf8; font-weight: 600; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #12131e; border: 1px solid #23273c; border-radius: 10px; padding: 14px; text-align: center; }
    .stat-val { font-size: 24px; font-weight: 700; color: #fff; }
    .stat-lbl { font-size: 11px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
    .footer { text-align: center; font-size: 12px; color: #4b5563; }
    .footer a { color: #818cf8; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🔒 Stealth Chat Server</div>
      <div class="status-badge"><span class="status-dot"></span> Live & Ready</div>
    </div>
    <p class="desc">Real-time WebSocket backend with persistent offline message holding and server-side AES-256-GCM encryption at rest.</p>
    
    <div class="security-banner">
      <span>🛡️ Server Encryption: <strong>AES-256-GCM</strong> (Key ID: ${cryptoVault.getKeyFingerprint()})</span>
      <span class="sec-tag">ACTIVE</span>
    </div>

    <div class="section-title">App WebSocket Connection URL</div>
    <div class="url-box">
      <span class="url-text">${wsUrl}</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val">${activeClients.size}</div>
        <div class="stat-lbl">Active Phones Online</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${registeredUsers.size}</div>
        <div class="stat-lbl">Registered Devices</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${vaultStats.pendingMessagesCount}</div>
        <div class="stat-lbl">Offline Messages in Vault</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${vaultStats.pendingStatusesCount}</div>
        <div class="stat-lbl">Queued Delivery Receipts</div>
      </div>
    </div>

    <div class="footer">
      JSON Health Probe: <a href="/health">/health</a> • Build: Production Ready
    </div>
  </div>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  const stats = offlineStore.getStats();
  res.json({
    status: 'ok',
    service: 'stealth-chat-backend',
    encryption: {
      type: 'AES-256-GCM',
      keyFingerprint: cryptoVault.getKeyFingerprint(),
      atRest: true
    },
    activeConnections: activeClients.size,
    registeredUsersCount: registeredUsers.size,
    offlineMessagesCount: stats.pendingMessagesCount,
    offlineStatusesCount: stats.pendingStatusesCount,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/users/register', (req, res) => {
  const { mobile, nickname } = req.body;
  const cleanMobile = normalizePhone(mobile);
  if (!cleanMobile) {
    return res.status(400).json({ error: 'Valid mobile number required' });
  }

  const user = {
    mobile: cleanMobile,
    nickname: nickname || `User-${cleanMobile.slice(-4)}`,
    registeredAt: Date.now()
  };
  registeredUsers.set(cleanMobile, user);
  console.log(`[REST] User registered: ${user.mobile} (${user.nickname})`);
  res.json({ success: true, user });
});

app.get('/api/users/check', (req, res) => {
  const cleanMobile = normalizePhone(req.query.mobile);
  const user = registeredUsers.get(cleanMobile);
  const isOnline = activeClients.has(cleanMobile);

  res.json({
    exists: !!user,
    isOnline,
    user: user || null
  });
});

app.get('/api/users', (req, res) => {
  const users = Array.from(registeredUsers.values()).map(u => ({
    ...u,
    isOnline: activeClients.has(u.mobile)
  }));
  res.json(users);
});

// WebSocket Real-time Messaging
wss.on('connection', (ws, req) => {
  let authenticatedMobile = null;
  console.log(`[WS] New client connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'REGISTER': {
          const cleanMobile = normalizePhone(msg.mobile);
          if (!cleanMobile) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid mobile number' }));
            return;
          }

          authenticatedMobile = cleanMobile;
          activeClients.set(cleanMobile, {
            ws,
            nickname: msg.nickname || cleanMobile,
            lastSeen: Date.now()
          });

          if (!registeredUsers.has(cleanMobile)) {
            registeredUsers.set(cleanMobile, {
              mobile: cleanMobile,
              nickname: msg.nickname || `User-${cleanMobile.slice(-4)}`,
              registeredAt: Date.now()
            });
          }

          console.log(`[WS] Client registered: ${cleanMobile}`);
          ws.send(JSON.stringify({
            type: 'REGISTER_ACK',
            status: 'OK',
            mobile: cleanMobile
          }));

          // Flush offline queued messages held in encrypted vault
          const queuedMessages = offlineStore.dequeueMessages(cleanMobile);
          if (queuedMessages.length > 0) {
            console.log(`[WS] Delivering ${queuedMessages.length} queued offline messages from encrypted vault to ${cleanMobile}`);
            for (const queuedMsg of queuedMessages) {
              ws.send(JSON.stringify(queuedMsg));
            }
          }

          // Flush any pending status updates (e.g. DELIVERED / READ receipts that occurred while this client was offline)
          const queuedStatuses = offlineStore.dequeueStatuses(cleanMobile);
          if (queuedStatuses.length > 0) {
            console.log(`[WS] Delivering ${queuedStatuses.length} queued status updates to ${cleanMobile}`);
            for (const statusMsg of queuedStatuses) {
              ws.send(JSON.stringify(statusMsg));
            }
          }
          break;
        }

        case 'SEND_MSG': {
          const sender = normalizePhone(msg.sender || authenticatedMobile);
          const recipient = normalizePhone(msg.recipient);

          if (!recipient || !sender) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Sender and recipient required' }));
            return;
          }

          const messageId = msg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const timestamp = msg.timestamp || Date.now();

          console.log(`[WS] Message ${messageId}: ${sender} -> ${recipient}`);

          // Immediately acknowledge receipt to sender (SENT status)
          ws.send(JSON.stringify({
            type: 'MSG_ACK',
            id: messageId,
            status: 'SENT',
            timestamp
          }));

          const relayPayload = {
            type: 'MSG_RELAY',
            id: messageId,
            sender,
            recipient,
            text: msg.text,
            timestamp
          };

          // Check if recipient is online
          const recipientSession = activeClients.get(recipient);
          if (recipientSession && recipientSession.ws.readyState === WebSocket.OPEN) {
            recipientSession.ws.send(JSON.stringify(relayPayload));
            console.log(`[WS] Delivered in real-time to ${recipient}`);

            // Notify sender of delivery
            ws.send(JSON.stringify({
              type: 'STATUS_UPDATE',
              id: messageId,
              status: 'DELIVERED',
              recipient
            }));
          } else {
            // Queue in persistent, server-side encrypted vault
            console.log(`[WS] Recipient ${recipient} is offline. Encrypting with AES-256-GCM and storing in offline vault.`);
            offlineStore.enqueueMessage(recipient, relayPayload);
          }
          break;
        }

        case 'STATUS_UPDATE': {
          const target = normalizePhone(msg.to);
          const targetSession = activeClients.get(target);
          const statusPayload = {
            type: 'STATUS_UPDATE',
            id: msg.id,
            status: msg.status, // "DELIVERED" or "READ"
            from: authenticatedMobile
          };

          if (targetSession && targetSession.ws.readyState === WebSocket.OPEN) {
            targetSession.ws.send(JSON.stringify(statusPayload));
          } else {
            // Target is currently offline, store encrypted status update in offline vault
            console.log(`[WS] Target ${target} for status update is offline. Encrypting & storing status receipt.`);
            offlineStore.enqueueStatus(target, statusPayload);
          }
          break;
        }

        case 'TYPING': {
          const target = normalizePhone(msg.to);
          const targetSession = activeClients.get(target);
          if (targetSession && targetSession.ws.readyState === WebSocket.OPEN) {
            targetSession.ws.send(JSON.stringify({
              type: 'TYPING',
              from: authenticatedMobile,
              isTyping: !!msg.isTyping
            }));
          }
          break;
        }

        case 'PING': {
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;
        }

        default:
          console.warn(`[WS] Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
    }
  });

  ws.on('close', () => {
    if (authenticatedMobile) {
      console.log(`[WS] Client disconnected: ${authenticatedMobile}`);
      activeClients.delete(authenticatedMobile);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${authenticatedMobile}:`, err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` Stealth Chat WebSocket Server running on port ${PORT}`);
  console.log(` Server-Side Encryption: AES-256-GCM [Key ID: ${cryptoVault.getKeyFingerprint()}]`);
  console.log(` Offline Encrypted Vault: Active (data/offline_vault.json)`);
  console.log(` Health check: http://localhost:${PORT}/health`);
  console.log(` WebSocket URL: ws://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
