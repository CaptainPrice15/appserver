const WebSocket = require('ws');
const assert = require('assert');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';

async function runTest() {
  console.log(`--- Starting Two-Phone Real-time WebSocket Test on ${SERVER_URL} ---`);

  const phoneA = new WebSocket(SERVER_URL);
  const phoneB = new WebSocket(SERVER_URL);

  let aRegistered = false;
  let bRegistered = false;
  let messageReceivedByB = null;
  let deliveryAckReceivedByA = false;
  let readAckReceivedByA = false;

  await new Promise((resolve, reject) => {
    let connectCount = 0;
    const checkConnect = () => {
      connectCount++;
      if (connectCount === 2) resolve();
    };
    phoneA.on('open', checkConnect);
    phoneB.on('open', checkConnect);
    phoneA.on('error', reject);
    phoneB.on('error', reject);
  });

  console.log('[Test] Both phones connected to WebSocket server.');

  phoneA.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'REGISTER_ACK') {
      aRegistered = true;
    }
    if (msg.type === 'STATUS_UPDATE' && msg.status === 'DELIVERED') {
      deliveryAckReceivedByA = true;
      console.log('[Test] Phone A received DELIVERED receipt for message!');
    }
    if (msg.type === 'STATUS_UPDATE' && msg.status === 'READ') {
      readAckReceivedByA = true;
      console.log('[Test] Phone A received READ receipt for message!');
    }
  });

  phoneB.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'REGISTER_ACK') {
      bRegistered = true;
    }
    if (msg.type === 'MSG_RELAY') {
      messageReceivedByB = msg;
      console.log(`[Test] Phone B received real-time message from ${msg.sender}: "${msg.text}"`);
      // Phone B marks as read
      phoneB.send(JSON.stringify({
        type: 'STATUS_UPDATE',
        id: msg.id,
        status: 'READ',
        to: msg.sender
      }));
    }
  });

  // 1. Register Phone A (+15550001)
  phoneA.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550001',
    nickname: 'Alice'
  }));

  // 2. Register Phone B (+15550002)
  phoneB.send(JSON.stringify({
    type: 'REGISTER',
    mobile: '+15550002',
    nickname: 'Bob'
  }));

  await new Promise(r => setTimeout(r, 400));
  assert(aRegistered, 'Phone A should be registered');
  assert(bRegistered, 'Phone B should be registered');
  console.log('[Test] Both phones successfully registered with their mobile numbers.');

  // 3. Phone A sends message to Phone B
  const testMsgId = 'test_msg_999';
  console.log('[Test] Phone A sending secret message to Phone B (+15550002)...');
  phoneA.send(JSON.stringify({
    type: 'SEND_MSG',
    id: testMsgId,
    sender: '+15550001',
    recipient: '+15550002',
    text: 'Hey Bob, secret game tonight?'
  }));

  await new Promise(r => setTimeout(r, 600));

  assert(messageReceivedByB !== null, 'Phone B should have received the message');
  assert.strictEqual(messageReceivedByB.text, 'Hey Bob, secret game tonight?');
  assert(deliveryAckReceivedByA, 'Phone A should have received DELIVERED ack');
  assert(readAckReceivedByA, 'Phone A should have received READ ack');

  console.log('--- Test Passed: Real-time messaging between two mobile numbers fully verified! ---');

  phoneA.close();
  phoneB.close();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test Failed]:', err);
  process.exit(1);
});
