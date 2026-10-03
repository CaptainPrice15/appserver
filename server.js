const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

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
const offlineQueue = new Map();  // recipientMobile -> [ messages ]
const registeredUsers = new Map(); // mobile -> { mobile, nickname, registeredAt }

// REST Endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'stealth-chat-backend',
    activeConnections: activeClients.size,
    registeredUsersCount: registeredUsers.size,
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

          // Flush offline queued messages
          if (offlineQueue.has(cleanMobile)) {
            const queue = offlineQueue.get(cleanMobile);
            console.log(`[WS] Delivering ${queue.length} queued offline messages to ${cleanMobile}`);
            while (queue.length > 0) {
              const queuedMsg = queue.shift();
              ws.send(JSON.stringify(queuedMsg));
            }
            offlineQueue.delete(cleanMobile);
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
            text: msg.text, // Encrypted payload
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
            // Queue for offline delivery
            console.log(`[WS] Recipient ${recipient} is offline. Message queued.`);
            if (!offlineQueue.has(recipient)) {
              offlineQueue.set(recipient, []);
            }
            offlineQueue.get(recipient).push(relayPayload);
          }
          break;
        }

        case 'STATUS_UPDATE': {
          const target = normalizePhone(msg.to);
          const targetSession = activeClients.get(target);
          if (targetSession && targetSession.ws.readyState === WebSocket.OPEN) {
            targetSession.ws.send(JSON.stringify({
              type: 'STATUS_UPDATE',
              id: msg.id,
              status: msg.status, // "DELIVERED" or "READ"
              from: authenticatedMobile
            }));
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
  console.log(` Health check: http://localhost:${PORT}/health`);
  console.log(` WebSocket URL: ws://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
