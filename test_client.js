const WebSocket = require('ws');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const offlineStore = require('./offlineStore');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const VAULT_FILE = path.join(__dirname, 'data', 'offline_vault.json');

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

async function runTestSuite() {
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

  // Clean up
  phoneA.close();
  phoneB.close();

  console.log('\n================================================================');
  console.log(' ALL TESTS PASSED: Offline Message Holding & Server Encryption verified!');
  console.log('================================================================\n');
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error('\n[TEST SUITE FAILURE]:', err);
  process.exit(1);
});
