const WebSocket = require('ws');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const offlineStore = require('./offlineStore');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const VAULT_FILE = path.join(__dirname, 'data', 'offline_vault.json');

let spawnedServer = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function ensureServerRunning() {
  try {
    const ws = await connectSocket(SERVER_URL);
    ws.close();
    return;
  } catch (e) {
    console.log('[Test Suite] Local server not running. Spawning server.js...');
    spawnedServer = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: 'inherit'
    });
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const ws = await connectSocket(SERVER_URL);
        ws.close();
        console.log('[Test Suite] server.js successfully spawned and ready.\n');
        return;
      } catch (err) {}
    }
    throw new Error('Failed to connect to spawned server.js');
  }
}

async function runTestSuite() {
  await ensureServerRunning();
  console.log(`================================================================`);
  console.log(` Starting Stealth Chat End-to-End & Offline Encryption Test Suite`);
  console.log(` Target Server URL: ${SERVER_URL}`);
  console.log(`================================================================\n`);

  // Ensure clean testing slate if local
  if (SERVER_URL.includes('localhost') || SERVER_URL.includes('127.0.0.1')) {
    offlineStore.clearAll();
  }

  // -------------------------------------------------------------
  // Test 1: Real-time Online Messaging (Alice -> Bob)
  // -------------------------------------------------------------
  console.log('[Test 1] Testing Real-time Online Delivery between Alice & Bob...');
  const phoneA = await connectSocket(SERVER_URL);
  let phoneB = await connectSocket(SERVER_URL);

  let aReceivedDeliveredAck = false;
  let bReceivedDirectMsg = null;

  phoneA.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'STATUS_UPDATE' && msg.status === 'DELIVERED') {
      aReceivedDeliveredAck = true;
    }
  });

  phoneB.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_RELAY') {
      bReceivedDirectMsg = msg;
    }
  });

  // Register both
  phoneA.send(JSON.stringify({ type: 'REGISTER', mobile: '+15550001', nickname: 'Alice' }));
  phoneB.send(JSON.stringify({ type: 'REGISTER', mobile: '+15550002', nickname: 'Bob' }));
  await sleep(300);

  // Send direct message
  phoneA.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_online_1',
    sender: '+15550001',
    recipient: '+15550002',
    text: 'ClientEncryptedPayload_DirectOnline'
  }));
  await sleep(400);

  assert(bReceivedDirectMsg !== null, 'Bob must receive real-time online message');
  assert.strictEqual(bReceivedDirectMsg.text, 'ClientEncryptedPayload_DirectOnline');
  assert(aReceivedDeliveredAck, 'Alice must receive immediate DELIVERED status');
  console.log(' -> PASSED: Real-time online delivery verified.\n');

  // -------------------------------------------------------------
  // Test 2: Offline Message Holding & Server-Side Encryption at Rest
  // -------------------------------------------------------------
  console.log('[Test 2] Testing Offline Message Holding & Server-Side AES-256-GCM Encryption...');
  // Bob goes offline (disconnects)
  phoneB.close();
  phoneB = null;
  await sleep(300);
  console.log(' -> Bob is now OFFLINE (phone turned off / app closed).');

  // Alice sends two messages to offline Bob
  const secretText1 = 'TOP_SECRET_DATA_ALPHA_98765';
  const secretText2 = 'TOP_SECRET_DATA_BRAVO_43210';

  let aliceSentAckCount = 0;
  phoneA.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_ACK' && msg.status === 'SENT') {
      aliceSentAckCount++;
    }
  });

  phoneA.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_offline_1',
    sender: '+15550001',
    recipient: '+15550002',
    text: secretText1
  }));

  phoneA.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_offline_2',
    sender: '+15550001',
    recipient: '+15550002',
    text: secretText2
  }));
  await sleep(500);

  console.log(' -> Alice sent 2 messages to offline Bob. Server acknowledged SENT.');

  // Verify server encrypted store on disk
  if (fs.existsSync(VAULT_FILE)) {
    const vaultContent = fs.readFileSync(VAULT_FILE, 'utf8');
    const parsedVault = JSON.parse(vaultContent);

    assert(parsedVault.messages.length >= 2, 'Vault must hold at least 2 offline messages');
    
    // SECURITY AUDIT: Verify that plaintext secrets DO NOT appear anywhere on disk!
    assert(!vaultContent.includes(secretText1), 'CRITICAL: Plaintext secretText1 MUST NOT leak to disk!');
    assert(!vaultContent.includes(secretText2), 'CRITICAL: Plaintext secretText2 MUST NOT leak to disk!');

    const record = parsedVault.messages.find(m => m.id === 'msg_offline_1');
    assert(record, 'Record for msg_offline_1 must exist in vault');
    assert(record.envelope.iv, 'Server envelope must contain cryptographic IV');
    assert(record.envelope.authTag, 'Server envelope must contain AES-GCM AuthTag');
    assert(record.envelope.ciphertext, 'Server envelope must contain AES-GCM ciphertext');

    console.log(' -> PASSED: Server-Side Encryption Verified! Message held at rest is fully encrypted.');
    console.log(`    Vault Record Sample: ID=${record.id}, IV=${record.envelope.iv.substring(0, 8)}..., AuthTag=${record.envelope.authTag.substring(0, 8)}...`);
  }

  // -------------------------------------------------------------
  // Test 3: Persistence Across Reboot / Reload Simulation
  // -------------------------------------------------------------
  console.log('\n[Test 3] Simulating Server Restart / Re-reading Encrypted Vault from Disk...');
  offlineStore.init(); // Force reload from disk
  const reloadedStats = offlineStore.getStats();
  assert(reloadedStats.pendingMessagesCount >= 2, 'Reloaded offline store must retain pending messages');
  console.log(` -> PASSED: Persistence verified! ${reloadedStats.pendingMessagesCount} offline messages retained after reload.`);

  // -------------------------------------------------------------
  // Test 4: Recipient Reconnects and Receives Offline Messages
  // -------------------------------------------------------------
  console.log('\n[Test 4] Bob reconnects to server and flushes encrypted vault...');
  phoneB = await connectSocket(SERVER_URL);

  const bobReceivedQueued = [];
  phoneB.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_RELAY') {
      bobReceivedQueued.push(msg);
      // Bob immediately sends back delivery status
      phoneB.send(JSON.stringify({
        type: 'STATUS_UPDATE',
        id: msg.id,
        status: 'DELIVERED',
        to: msg.sender
      }));
    }
  });

  // Bob registers
  phoneB.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550002',
    nickname: 'Bob'
  }));

  await sleep(600);

  assert.strictEqual(bobReceivedQueued.length, 2, 'Bob must receive exactly 2 queued offline messages');
  assert.strictEqual(bobReceivedQueued[0].text, secretText1, 'First decrypted message matches');
  assert.strictEqual(bobReceivedQueued[1].text, secretText2, 'Second decrypted message matches');

  console.log(' -> PASSED: Bob successfully received and decrypted all offline held messages upon reconnecting!');

  // Verify vault has dequeued the delivered messages
  offlineStore.init(); // Reload from disk to observe server's dequeue
  const remainingStats = offlineStore.getStats();
  assert.strictEqual(remainingStats.pendingMessagesCount, 0, 'Vault must safely purge delivered messages');
  console.log(' -> PASSED: Delivered messages safely purged from the server vault.');

  // Clean up Test 1-4 sockets
  phoneA.close();
  phoneB.close();
  await sleep(300);

  // -------------------------------------------------------------
  // Test 5: Multi-Device Concurrent Sessions, Fan-out & MSG_SYNC
  // -------------------------------------------------------------
  console.log('\n[Test 5] Testing Multi-Device Concurrent Sessions, Fan-out & MSG_SYNC...');
  let carolDev1 = await connectSocket(SERVER_URL);
  let carolDev2 = await connectSocket(SERVER_URL);
  let daveDev1 = await connectSocket(SERVER_URL);

  let c1LinkedDevices = null;
  let c2LinkedDevices = null;
  let c2ReceivedSyncMsg = null;
  let d1ReceivedMsg = null;
  let c1ReceivedReadStatus = false;
  let c2ReceivedReadStatus = false;

  carolDev1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'REGISTER_ACK' || msg.type === 'DEVICE_LIST_UPDATE') {
      c1LinkedDevices = msg.linkedDevices;
    }
    if (msg.type === 'STATUS_UPDATE' && msg.status === 'READ') {
      c1ReceivedReadStatus = true;
    }
  });

  carolDev2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'REGISTER_ACK' || msg.type === 'DEVICE_LIST_UPDATE') {
      c2LinkedDevices = msg.linkedDevices;
    }
    if (msg.type === 'MSG_SYNC') {
      c2ReceivedSyncMsg = msg;
    }
    if (msg.type === 'STATUS_UPDATE' && msg.status === 'READ') {
      c2ReceivedReadStatus = true;
    }
  });

  daveDev1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_RELAY') {
      d1ReceivedMsg = msg;
    }
  });

  // Register Carol on 2 devices with the same mobile number
  carolDev1.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550003',
    nickname: 'Carol',
    deviceId: 'carol_phone',
    deviceName: 'Carol Galaxy S24'
  }));

  carolDev2.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550003',
    nickname: 'Carol',
    deviceId: 'carol_tablet',
    deviceName: 'Carol Galaxy Tab'
  }));

  daveDev1.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550004',
    nickname: 'Dave',
    deviceId: 'dave_phone',
    deviceName: 'Dave Pixel 8'
  }));

  await sleep(600);

  assert(c1LinkedDevices && c1LinkedDevices.length === 2, `Carol Dev 1 must see 2 linked devices, got: ${JSON.stringify(c1LinkedDevices)}`);
  assert(c2LinkedDevices && c2LinkedDevices.length === 2, `Carol Dev 2 must see 2 linked devices, got: ${JSON.stringify(c2LinkedDevices)}`);
  console.log(' -> PASSED: Carol registered 2 devices concurrently under one mobile number!');

  // Carol sends a message from Phone (dev 1) to Dave
  const multiMsgText = 'Multi-device greeting from Carol Phone';
  carolDev1.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_multi_1',
    sender: '+15550003',
    recipient: '+15550004',
    text: multiMsgText,
    senderDeviceId: 'carol_phone'
  }));

  await sleep(500);

  // Dave receives it
  assert(d1ReceivedMsg !== null, 'Dave must receive the relayed message');
  assert.strictEqual(d1ReceivedMsg.text, multiMsgText);

  // Carol Tablet (dev 2) receives MSG_SYNC
  assert(c2ReceivedSyncMsg !== null, 'Carol Tablet (dev 2) must receive MSG_SYNC');
  assert.strictEqual(c2ReceivedSyncMsg.text, multiMsgText);
  assert.strictEqual(c2ReceivedSyncMsg.recipient, '+15550004');
  console.log(' -> PASSED: Dave received relayed message AND Carol Tablet received MSG_SYNC self-sync!');

  // Dave marks as READ
  daveDev1.send(JSON.stringify({
    type: 'STATUS_UPDATE',
    id: 'msg_multi_1',
    status: 'READ',
    to: '+15550003'
  }));

  await sleep(400);

  assert(c1ReceivedReadStatus, 'Carol Phone must receive READ status update');
  assert(c2ReceivedReadStatus, 'Carol Tablet must also receive READ status update (fan-out)');
  console.log(' -> PASSED: Read status update fanned out to both of Carol\'s devices!');

  // Disconnect Carol Tablet and test offline hold specifically for dev 2
  carolDev2.close();
  await sleep(300);

  daveDev1.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_multi_offline_tablet',
    sender: '+15550004',
    recipient: '+15550003',
    text: 'Hey Carol Tablet check this out'
  }));

  await sleep(400);

  // Reconnect Carol Tablet
  let tabletQueuedReceived = false;
  carolDev2 = await connectSocket(SERVER_URL);
  carolDev2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_RELAY' && msg.id === 'msg_multi_offline_tablet') {
      tabletQueuedReceived = true;
    }
  });

  carolDev2.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550003',
    nickname: 'Carol',
    deviceId: 'carol_tablet',
    deviceName: 'Carol Galaxy Tab'
  }));

  await sleep(500);
  assert(tabletQueuedReceived, 'Reconnected Carol Tablet must receive offline queued message');
  console.log(' -> PASSED: Offline queue delivered message to tablet upon reconnecting!');

  // Clean up
  carolDev1.close();
  carolDev2.close();
  daveDev1.close();
  await sleep(300);

  // -------------------------------------------------------------
  // Test 8: Encrypted Media Upload/Download, HD Metadata Relay & Offline Reactions
  // -------------------------------------------------------------
  console.log('\n[Test 8] Testing Encrypted Media Upload/Download, HD Relay & Offline Reactions...');
  const HTTP_URL = SERVER_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

  // 1. Upload Encrypted Binary Media
  const fakeEncryptedPayload = Buffer.from('AES_256_GCM_ENCRYPTED_MEDIA_BLOB_BYTE_SEQUENCE_' + 'X'.repeat(5000));
  const uploadRes = await fetch(`${HTTP_URL}/api/media/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fakeEncryptedPayload
  });
  assert(uploadRes.status === 200 || uploadRes.status === 201, `Media upload must return 200/201, got ${uploadRes.status}`);
  const uploadData = await uploadRes.json();
  assert(uploadData.success, 'Upload response must be success');
  assert(uploadData.mediaId, 'Upload response must have mediaId');
  const testMediaId = uploadData.mediaId;
  console.log(` -> PASSED: Media binary uploaded successfully! ID: ${testMediaId}`);

  // 2. Download Encrypted Binary Media
  const downloadRes = await fetch(`${HTTP_URL}/api/media/${testMediaId}`);
  assert.strictEqual(downloadRes.status, 200, 'Media download must return 200 OK');
  const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());
  assert(downloadedBuffer.equals(fakeEncryptedPayload), 'Downloaded media must match uploaded ciphertext bit-for-bit');
  console.log(' -> PASSED: Encrypted media downloaded and verified identical bit-for-bit.');

  // 3. Media Message Relay with HD Metadata
  let mediaUserA = await connectSocket(SERVER_URL);
  let mediaUserB = await connectSocket(SERVER_URL);

  let bReceivedMediaMsg = null;
  mediaUserB.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_RELAY' && msg.id === 'msg_media_hd_1') {
      bReceivedMediaMsg = msg;
    }
  });

  mediaUserA.send(JSON.stringify({ type: 'REGISTER', mobile: '+15550008', nickname: 'MediaA' }));
  mediaUserB.send(JSON.stringify({ type: 'REGISTER', mobile: '+15550009', nickname: 'MediaB' }));
  await sleep(400);

  mediaUserA.send(JSON.stringify({
    type: 'SEND_MSG',
    id: 'msg_media_hd_1',
    sender: '+15550008',
    recipient: '+15550009',
    text: 'Encrypted HD Photo Caption',
    messageType: 'IMAGE',
    mediaId: testMediaId,
    isHd: true,
    mediaSize: fakeEncryptedPayload.length
  }));
  await sleep(500);

  assert(bReceivedMediaMsg !== null, 'Recipient must receive media relay message');
  assert.strictEqual(bReceivedMediaMsg.messageType, 'IMAGE', 'Message type must be IMAGE');
  assert.strictEqual(bReceivedMediaMsg.mediaId, testMediaId, 'Media ID must match');
  assert.strictEqual(bReceivedMediaMsg.isHd, true, 'isHd must be true');
  assert.strictEqual(bReceivedMediaMsg.mediaSize, fakeEncryptedPayload.length, 'Media size must match');
  console.log(' -> PASSED: HD Media metadata relayed with high fidelity!');

  // 4. Offline Reaction Queueing and Dequeueing
  console.log(' -> Testing offline reaction queuing for recipient...');
  mediaUserB.close();
  await sleep(300);

  // Send reaction while MediaB is offline
  mediaUserA.send(JSON.stringify({
    type: 'MSG_REACTION',
    id: 'msg_media_hd_1',
    to: '+15550009',
    reaction: '🔥'
  }));
  await sleep(500);

  // Verify reaction is in offlineStore
  offlineStore.init();
  const reactionStats = offlineStore.getStats();
  assert(reactionStats.pendingReactionsCount >= 1, 'Offline store must hold queued reaction');
  console.log(` -> PASSED: Offline reaction queued at rest (${reactionStats.pendingReactionsCount} pending).`);

  // MediaB reconnects and flushes vault
  let bReceivedQueuedReaction = null;
  mediaUserB = await connectSocket(SERVER_URL);
  mediaUserB.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'MSG_REACTION' && msg.id === 'msg_media_hd_1') {
      bReceivedQueuedReaction = msg;
    }
  });

  mediaUserB.send(JSON.stringify({ type: 'REGISTER', mobile: '+15550009', nickname: 'MediaB' }));
  await sleep(600);

  assert(bReceivedQueuedReaction !== null, 'Reconnected MediaB must receive queued reaction');
  assert.strictEqual(bReceivedQueuedReaction.reaction, '🔥', 'Delivered reaction emoji must match');
  console.log(' -> PASSED: Offline reaction successfully delivered upon recipient reconnection!');

  mediaUserA.close();
  mediaUserB.close();

  if (spawnedServer) {
    spawnedServer.kill();
  }

  console.log('\n================================================================');
  console.log(' ALL TESTS PASSED: Offline Message Holding, Media & Multi-Device verified!');
  console.log('================================================================\n');
  process.exit(0);
}

runTestSuite().catch((err) => {
  if (spawnedServer) {
    spawnedServer.kill();
  }
  console.error('\n[TEST SUITE FAILURE]:', err);
  process.exit(1);
});
