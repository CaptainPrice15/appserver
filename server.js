const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const cryptoVault = require('./cryptoVault');
const offlineStore = require('./offlineStore');
const { normalizePhone, phonesMatch } = require('./phoneUtils');

const app = express();
app.use(cors());
app.use(express.json());

// Render sets PORT automatically (e.g., 10000); default to 8080 locally
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Memory stores
// activeClients: mobile -> Map<deviceId, { ws, deviceId, deviceName, nickname, lastSeen }>
const activeClients = new Map();
// registeredDevices: mobile -> Map<deviceId, { deviceId, deviceName, registeredAt, lastSeen }>
const registeredDevices = new Map();
// registeredUsers: mobile -> { mobile, nickname, registeredAt }
const registeredUsers = new Map();

// Helper to get all active device sessions for a phone
function getActiveDeviceSessions(phone) {
  if (!phone) return [];
  const norm = normalizePhone(phone);
  const sessions = [];

  for (const [clientMobile, deviceMap] of activeClients.entries()) {
    if (phonesMatch(clientMobile, norm)) {
      for (const [deviceId, session] of deviceMap.entries()) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          sessions.push(session);
        }
      }
    }
  }
  return sessions;
}

// Helper to find client session by exact or flexible phone match (backwards compatibility)
function findActiveClient(phone) {
  const sessions = getActiveDeviceSessions(phone);
  if (sessions.length > 0) {
    return { mobile: normalizePhone(phone), session: sessions[0] };
  }
  return null;
}

// Helper to get registered devices list with online status
function getRegisteredDevicesList(phone, currentDeviceId = null) {
  const norm = normalizePhone(phone);
  const list = [];
  for (const [userMobile, deviceMap] of registeredDevices.entries()) {
    if (phonesMatch(userMobile, norm)) {
      const activeMap = activeClients.get(userMobile);
      for (const [devId, devInfo] of deviceMap.entries()) {
        const isActive = activeMap && activeMap.has(devId) && activeMap.get(devId).ws.readyState === WebSocket.OPEN;
        list.push({
          deviceId: devId,
          deviceName: devInfo.deviceName || 'Android Device',
          registeredAt: devInfo.registeredAt || Date.now(),
          lastSeen: devInfo.lastSeen || Date.now(),
          isCurrent: currentDeviceId ? devId === currentDeviceId : false,
          isOnline: !!isActive
        });
      }
    }
  }
  return list;
}

// Helper to get IDs of devices that are currently offline
function getOfflineDeviceIds(phone) {
  const norm = normalizePhone(phone);
  const offlineIds = [];
  for (const [userMobile, deviceMap] of registeredDevices.entries()) {
    if (phonesMatch(userMobile, norm)) {
      const activeMap = activeClients.get(userMobile);
      for (const devId of deviceMap.keys()) {
        const isOnline = activeMap && activeMap.has(devId) && activeMap.get(devId).ws.readyState === WebSocket.OPEN;
        if (!isOnline) {
          offlineIds.push(devId);
        }
      }
    }
  }
  return offlineIds;
}

// Helper to find registered user by exact or flexible phone match
function findRegisteredUser(phone) {
  if (!phone) return null;
  const norm = normalizePhone(phone);
  if (registeredUsers.has(norm)) {
    return registeredUsers.get(norm);
  }
  for (const [userMobile, user] of registeredUsers.entries()) {
    if (phonesMatch(userMobile, phone)) {
      return user;
    }
  }
  return null;
}

// Helper to flush all pending vault messages and delivery receipts for a device
function flushVaultForDevice(mobile, deviceId, ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { deliveredMessages: 0, deliveredStatuses: 0 };
  }

  const cleanMobile = normalizePhone(mobile);
  const queuedMessages = offlineStore.dequeueMessages(cleanMobile, deviceId);
  if (queuedMessages.length > 0) {
    console.log(`[WS] Delivering ${queuedMessages.length} queued offline messages from encrypted vault to ${cleanMobile} (device: ${deviceId || 'any'})`);
    for (const queuedMsg of queuedMessages) {
      ws.send(JSON.stringify(queuedMsg));
    }
  }

  const queuedStatuses = offlineStore.dequeueStatuses(cleanMobile, deviceId);
  if (queuedStatuses.length > 0) {
    console.log(`[WS] Delivering ${queuedStatuses.length} queued status updates to ${cleanMobile} (device: ${deviceId || 'any'})`);
    for (const statusMsg of queuedStatuses) {
      ws.send(JSON.stringify(statusMsg));
    }
  }

  return { deliveredMessages: queuedMessages.length, deliveredStatuses: queuedStatuses.length };
}

function flushVaultForMobile(mobile, targetWs = null) {
  let ws = targetWs;
  if (!ws) {
    const client = findActiveClient(mobile);
    if (client && client.session.ws.readyState === WebSocket.OPEN) {
      ws = client.session.ws;
    }
  }
  return flushVaultForDevice(mobile, null, ws);
}

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
  let totalConnections = 0;
  for (const deviceMap of activeClients.values()) {
    totalConnections += deviceMap.size;
  }
  let totalDevices = 0;
  for (const deviceMap of registeredDevices.values()) {
    totalDevices += deviceMap.size;
  }

  res.json({
    status: 'ok',
    service: 'stealth-chat-backend',
    encryption: {
      type: 'AES-256-GCM',
      keyFingerprint: cryptoVault.getKeyFingerprint(),
      atRest: true
    },
    activeConnections: totalConnections,
    registeredUsersCount: registeredUsers.size,
    registeredDevicesCount: totalDevices,
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
  const phone = req.query.mobile;
  const user = findRegisteredUser(phone);
  const clientInfo = findActiveClient(phone);

  res.json({
    exists: !!user,
    isOnline: !!clientInfo,
    user: user || null
  });
});

app.get('/api/users', (req, res) => {
  const users = Array.from(registeredUsers.values()).map(u => ({
    ...u,
    isOnline: !!findActiveClient(u.mobile)
  }));
  res.json(users);
});

// Multi-Device Management REST Endpoints
app.get('/api/devices', (req, res) => {
  const phone = req.query.mobile;
  if (!phone) return res.status(400).json({ error: 'Mobile required' });
  const norm = normalizePhone(phone);
  const currentDev = req.query.deviceId || null;
  res.json({
    mobile: norm,
    devices: getRegisteredDevicesList(norm, currentDev)
  });
});

app.delete('/api/devices/:deviceId', (req, res) => {
  const phone = req.query.mobile;
  const devId = req.params.deviceId;
  if (!phone || !devId) return res.status(400).json({ error: 'Mobile and deviceId required' });
  const norm = normalizePhone(phone);

  // Terminate socket if active
  const activeMap = activeClients.get(norm);
  if (activeMap && activeMap.has(devId)) {
    const session = activeMap.get(devId);
    session.ws.close(4001, 'Device unlinked by owner');
    activeMap.delete(devId);
  }

  // Remove from registered devices
  const devMap = registeredDevices.get(norm);
  if (devMap) devMap.delete(devId);

  // Broadcast update to remaining active devices
  const remaining = getActiveDeviceSessions(norm);
  for (const s of remaining) {
    s.ws.send(JSON.stringify({
      type: 'DEVICE_LIST_UPDATE',
      linkedDevices: getRegisteredDevicesList(norm, s.deviceId)
    }));
  }

  res.json({ success: true, remaining: getRegisteredDevicesList(norm) });
});

// Vault diagnostic and manual flush endpoints
app.get('/api/vault/pending', (req, res) => {
  res.json(offlineStore.getPendingOverview());
});

app.get('/api/vault/flush', (req, res) => {
  let totalMessages = 0;
  let totalStatuses = 0;
  for (const [clientMobile, deviceMap] of activeClients.entries()) {
    for (const [devId, session] of deviceMap.entries()) {
      const result = flushVaultForDevice(clientMobile, devId, session.ws);
      totalMessages += result.deliveredMessages;
      totalStatuses += result.deliveredStatuses;
    }
  }
  res.json({
    success: true,
    flushedMessages: totalMessages,
    flushedStatuses: totalStatuses,
    remainingVaultStats: offlineStore.getStats()
  });
});

// WebSocket Real-time Messaging
wss.on('connection', (ws, req) => {
  let authenticatedMobile = null;
  let authenticatedDeviceId = null;
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

          const deviceId = msg.deviceId || 'default';
          const deviceName = msg.deviceName || 'Android Device';
          authenticatedMobile = cleanMobile;
          authenticatedDeviceId = deviceId;

          // Register in registeredDevices
          if (!registeredDevices.has(cleanMobile)) {
            registeredDevices.set(cleanMobile, new Map());
          }
          const userDeviceMap = registeredDevices.get(cleanMobile);
          const existingDev = userDeviceMap.get(deviceId) || {};
          userDeviceMap.set(deviceId, {
            deviceId,
            deviceName,
            registeredAt: existingDev.registeredAt || Date.now(),
            lastSeen: Date.now()
          });

          // Add to active clients map
          if (!activeClients.has(cleanMobile)) {
            activeClients.set(cleanMobile, new Map());
          }
          activeClients.get(cleanMobile).set(deviceId, {
            ws,
            deviceId,
            deviceName,
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

          console.log(`[WS] Client registered: ${cleanMobile} [Device: ${deviceName} (${deviceId})]`);
          const linkedDevices = getRegisteredDevicesList(cleanMobile, deviceId);

          ws.send(JSON.stringify({
            type: 'REGISTER_ACK',
            status: 'OK',
            mobile: cleanMobile,
            deviceId,
            linkedDevices
          }));

          // Broadcast updated device list to all other active devices of this mobile
          const activeSessions = getActiveDeviceSessions(cleanMobile);
          for (const session of activeSessions) {
            if (session.deviceId !== deviceId && session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify({
                type: 'DEVICE_LIST_UPDATE',
                linkedDevices: getRegisteredDevicesList(cleanMobile, session.deviceId)
              }));
            }
          }

          // Flush offline queued messages held in encrypted vault for this device
          flushVaultForDevice(cleanMobile, deviceId, ws);
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
          const senderDeviceId = msg.senderDeviceId || authenticatedDeviceId || 'dev_sender';

          console.log(`[WS] Message ${messageId}: ${sender} (${senderDeviceId}) -> ${recipient}`);

          // 1. Immediately acknowledge receipt to sender device (SENT status)
          ws.send(JSON.stringify({
            type: 'MSG_ACK',
            id: messageId,
            status: 'SENT',
            timestamp
          }));

          // 2. Self-Sync: Deliver MSG_SYNC to all OTHER active devices owned by the sender
          const senderSessions = getActiveDeviceSessions(sender);
          for (const sSession of senderSessions) {
            if (sSession.deviceId !== senderDeviceId && sSession.ws.readyState === WebSocket.OPEN) {
              sSession.ws.send(JSON.stringify({
                type: 'MSG_SYNC',
                id: messageId,
                sender,
                recipient,
                text: msg.text,
                timestamp,
                status: 'SENT',
                isOutgoing: true
              }));
              console.log(`[WS] Self-synced outgoing message ${messageId} to sender's other device: ${sSession.deviceId}`);
            }
          }

          // Also queue MSG_SYNC for any offline devices of the sender
          const offlineSenderDevices = getOfflineDeviceIds(sender).filter(id => id !== senderDeviceId);
          if (offlineSenderDevices.length > 0) {
            offlineStore.enqueueMessage(sender, {
              type: 'MSG_SYNC',
              id: messageId,
              sender,
              recipient,
              text: msg.text,
              timestamp,
              status: 'SENT',
              isOutgoing: true
            }, offlineSenderDevices);
          }

          const relayPayload = {
            type: 'MSG_RELAY',
            id: messageId,
            sender,
            recipient,
            text: msg.text,
            timestamp
          };

          // 3. Multi-Device Fan-Out to Recipient
          const recipientSessions = getActiveDeviceSessions(recipient);
          const recipientOfflineDevices = getOfflineDeviceIds(recipient);

          if (recipientSessions.length > 0) {
            for (const rSession of recipientSessions) {
              if (rSession.ws.readyState === WebSocket.OPEN) {
                // First flush any previously queued vault messages for this recipient device
                flushVaultForDevice(recipient, rSession.deviceId, rSession.ws);
                // Deliver message in real-time
                rSession.ws.send(JSON.stringify(relayPayload));
                console.log(`[WS] Delivered in real-time to ${recipient} (Device: ${rSession.deviceId})`);
              }
            }

            // Notify sender of delivery
            ws.send(JSON.stringify({
              type: 'STATUS_UPDATE',
              id: messageId,
              status: 'DELIVERED',
              recipient
            }));
          }

          // If recipient has offline devices (or no devices are online at all):
          if (recipientOfflineDevices.length > 0 || recipientSessions.length === 0) {
            const targets = recipientOfflineDevices.length > 0 ? recipientOfflineDevices : null;
            console.log(`[WS] Recipient ${recipient} has offline devices (${targets ? targets.join(',') : 'all'}). Encrypting and queuing in offline vault.`);
            offlineStore.enqueueMessage(recipient, relayPayload, targets);
          }
          break;
        }

        case 'STATUS_UPDATE': {
          const target = normalizePhone(msg.to);
          const statusPayload = {
            type: 'STATUS_UPDATE',
            id: msg.id,
            status: msg.status, // "DELIVERED" or "READ"
            from: authenticatedMobile
          };

          // 1. Deliver to all online devices of the target sender
          const targetSessions = getActiveDeviceSessions(target);
          if (targetSessions.length > 0) {
            for (const tSession of targetSessions) {
              if (tSession.ws.readyState === WebSocket.OPEN) {
                tSession.ws.send(JSON.stringify(statusPayload));
              }
            }
          } else {
            offlineStore.enqueueStatus(target, statusPayload);
          }

          // 2. Self-Sync: If READ status, synchronize read receipt to reader's other devices
          if (msg.status === 'READ' && authenticatedMobile) {
            const myOtherSessions = getActiveDeviceSessions(authenticatedMobile);
            for (const mSession of myOtherSessions) {
              if (mSession.deviceId !== authenticatedDeviceId && mSession.ws.readyState === WebSocket.OPEN) {
                mSession.ws.send(JSON.stringify({
                  type: 'STATUS_SYNC',
                  id: msg.id,
                  status: 'READ',
                  peerMobile: target
                }));
              }
            }
          }
          break;
        }

        case 'MSG_REACTION': {
          const target = normalizePhone(msg.to);
          const reactionPayload = {
            type: 'MSG_REACTION',
            id: msg.id,
            reaction: msg.reaction,
            from: authenticatedMobile
          };

          const targetSessions = getActiveDeviceSessions(target);
          for (const tSession of targetSessions) {
            if (tSession.ws.readyState === WebSocket.OPEN) {
              tSession.ws.send(JSON.stringify(reactionPayload));
            }
          }

          // Self-sync reaction to reader's other devices
          if (authenticatedMobile) {
            const myOtherSessions = getActiveDeviceSessions(authenticatedMobile);
            for (const mSession of myOtherSessions) {
              if (mSession.deviceId !== authenticatedDeviceId && mSession.ws.readyState === WebSocket.OPEN) {
                mSession.ws.send(JSON.stringify({
                  type: 'REACTION_SYNC',
                  id: msg.id,
                  reaction: msg.reaction,
                  peerMobile: target
                }));
              }
            }
          }
          break;
        }

        case 'DEVICE_UNLINK': {
          const targetDevId = msg.targetDeviceId;
          if (authenticatedMobile && targetDevId) {
            console.log(`[WS] Unlinking device ${targetDevId} for ${authenticatedMobile}`);
            const activeMap = activeClients.get(authenticatedMobile);
            if (activeMap && activeMap.has(targetDevId)) {
              const targetSession = activeMap.get(targetDevId);
              targetSession.ws.close(4001, 'Device unlinked by owner');
              activeMap.delete(targetDevId);
            }
            registeredDevices.get(authenticatedMobile)?.delete(targetDevId);

            const remainingSessions = getActiveDeviceSessions(authenticatedMobile);
            for (const s of remainingSessions) {
              s.ws.send(JSON.stringify({
                type: 'DEVICE_LIST_UPDATE',
                linkedDevices: getRegisteredDevicesList(authenticatedMobile, s.deviceId)
              }));
            }
          }
          break;
        }

        case 'TYPING': {
          const target = normalizePhone(msg.to);
          const targetSessions = getActiveDeviceSessions(target);
          for (const tSession of targetSessions) {
            if (tSession.ws.readyState === WebSocket.OPEN) {
              tSession.ws.send(JSON.stringify({
                type: 'TYPING',
                from: authenticatedMobile,
                isTyping: !!msg.isTyping
              }));
            }
          }
          break;
        }

        case 'PANIC_ALERT': {
          const target = normalizePhone(msg.to);
          const sender = normalizePhone(msg.sender || msg.from || authenticatedMobile);

          if (!target) break;

          console.log(`[WS] Panic alert received: ${sender} -> ${target}`);
          const targetSessions = getActiveDeviceSessions(target);
          const panicPayload = {
            type: 'PANIC_ALERT',
            from: sender,
            timestamp: msg.timestamp || Date.now()
          };

          if (targetSessions.length > 0) {
            for (const tSession of targetSessions) {
              if (tSession.ws.readyState === WebSocket.OPEN) {
                tSession.ws.send(JSON.stringify(panicPayload));
              }
            }
          } else {
            console.log(`[WS] Target ${target} for panic alert is offline. Storing in offline vault.`);
            offlineStore.enqueueMessage(target, {
              ...panicPayload,
              id: `panic_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
            });
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
    if (authenticatedMobile && authenticatedDeviceId) {
      console.log(`[WS] Device disconnected: ${authenticatedMobile} (${authenticatedDeviceId})`);
      const userActiveMap = activeClients.get(authenticatedMobile);
      if (userActiveMap) {
        userActiveMap.delete(authenticatedDeviceId);
        if (userActiveMap.size === 0) {
          activeClients.delete(authenticatedMobile);
        }
      }
      const userDevMap = registeredDevices.get(authenticatedMobile);
      if (userDevMap && userDevMap.has(authenticatedDeviceId)) {
        userDevMap.get(authenticatedDeviceId).lastSeen = Date.now();
      }

      // Broadcast update to remaining active devices
      const remaining = getActiveDeviceSessions(authenticatedMobile);
      for (const s of remaining) {
        if (s.ws.readyState === WebSocket.OPEN) {
          s.ws.send(JSON.stringify({
            type: 'DEVICE_LIST_UPDATE',
            linkedDevices: getRegisteredDevicesList(authenticatedMobile, s.deviceId)
          }));
        }
      }
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
