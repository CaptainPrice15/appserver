const WebSocket = require('ws');
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_URL = process.env.SERVER_URL || 'ws://127.0.0.1:8080';
const HTTP_BASE = SERVER_URL.replace('ws://', 'http://').replace('wss://', 'https://');

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

function postBinary(url, buffer, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
        ...headers
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getBinary(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: Buffer.concat(chunks),
          headers: res.headers
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function deleteRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'DELETE',
      headers
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let serverProcess = null;

async function runVaultTests() {
  console.log('================================================================');
  console.log(' Starting Private Media Vault & Multi-Device Sync Verification');
  console.log('================================================================\n');

  // Spawn server if not active
  try {
    const testWs = await connectSocket(SERVER_URL);
    testWs.close();
    console.log('[Setup] Server already running at ' + SERVER_URL);
  } catch (_) {
    console.log('[Setup] Spawning local server.js...');
    serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit' });
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const testWs = await connectSocket(SERVER_URL);
        testWs.close();
        console.log('[Setup] server.js ready!');
        break;
      } catch (err) {}
    }
  }

  const testMobile = '+19998887777';

  // 1. Connect Device A and Device B (Linked devices using SAME phone number)
  console.log('[Test 1] Connecting Device A and Device B with same phone number...');
  const devA = await connectSocket(SERVER_URL);
  const devB = await connectSocket(SERVER_URL);

  let devBReceivedVaultItem = null;
  let devAReceivedVaultDelete = null;

  devA.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'VAULT_ITEM_DELETED') {
      devAReceivedVaultDelete = m;
    }
  });

  devB.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'VAULT_ITEM_ADDED') {
      devBReceivedVaultItem = m.item;
    }
  });

  devA.send(JSON.stringify({
    type: 'REGISTER',
    mobile: testMobile,
    deviceId: 'device_primary',
    deviceName: 'Pixel 8'
  }));

  devB.send(JSON.stringify({
    type: 'REGISTER',
    mobile: testMobile,
    deviceId: 'device_tablet',
    deviceName: 'Galaxy Tab'
  }));

  await sleep(300);
  console.log('✓ Both linked devices registered under ' + testMobile);

  // 2. Upload Encrypted Image from Device A
  console.log('[Test 2] Uploading encrypted image to OCI vault...');
  const fakeEncryptedImg = Buffer.from('FAKECIPHER_IMAGE_AES256GCM_' + Date.now());
  const uploadImgRes = await postBinary(`${HTTP_BASE}/api/vault/media/upload`, fakeEncryptedImg, {
    'x-mobile': testMobile,
    'x-device-id': 'device_primary',
    'x-media-type': 'IMAGE',
    'x-file-name': 'vacation_sunset.jpg'
  });

  assert.strictEqual(uploadImgRes.status, 200, 'Upload should return HTTP 200');
  assert.strictEqual(uploadImgRes.data.success, true);
  const imgItem = uploadImgRes.data.item;
  assert.strictEqual(imgItem.mediaType, 'IMAGE');
  assert.strictEqual(imgItem.fileSize, fakeEncryptedImg.length);
  console.log(`✓ Image stored: ${imgItem.id} (${imgItem.fileName}, ${imgItem.fileSize} bytes)`);

  // Verify Device B received real-time sync notification
  await sleep(200);
  assert.ok(devBReceivedVaultItem, 'Device B must receive VAULT_ITEM_ADDED over WebSocket');
  assert.strictEqual(devBReceivedVaultItem.id, imgItem.id);
  console.log(`✓ Real-time multi-device sync confirmed: Device B received ${devBReceivedVaultItem.id}`);

  // 3. Upload Encrypted Video from Device B
  console.log('[Test 3] Uploading encrypted video to OCI vault from Device B...');
  const fakeEncryptedVideo = Buffer.from('FAKECIPHER_VIDEO_MP4_EXOPLAYER_STREAM_' + '0'.repeat(1024));
  const uploadVidRes = await postBinary(`${HTTP_BASE}/api/vault/media/upload`, fakeEncryptedVideo, {
    'x-mobile': testMobile,
    'x-device-id': 'device_tablet',
    'x-media-type': 'VIDEO',
    'x-file-name': 'birthday_video.mp4',
    'x-duration-sec': '72'
  });

  assert.strictEqual(uploadVidRes.status, 200);
  const vidItem = uploadVidRes.data.item;
  assert.strictEqual(vidItem.mediaType, 'VIDEO');
  assert.strictEqual(vidItem.durationSec, 72);
  console.log(`✓ Video stored: ${vidItem.id} (Duration: 72s, Size: ${vidItem.fileSize} bytes)`);

  // 4. Query Vault List
  console.log('[Test 4] Querying vault list for account...');
  const listRes = await getJson(`${HTTP_BASE}/api/vault/media/list?mobile=${encodeURIComponent(testMobile)}`);
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(listRes.data.success, true);
  assert.strictEqual(listRes.data.count >= 2, true);
  console.log(`✓ Vault list query returned ${listRes.data.count} items:`);
  for (const it of listRes.data.items) {
    console.log(`   - [${it.mediaType}] ${it.fileName} (${it.fileSize} B, uploaded by ${it.uploaderDeviceId})`);
  }

  // 5. Test Streaming Media Download (Full Binary)
  console.log('[Test 5] Testing zero-footprint streaming endpoint...');
  const streamRes = await getBinary(`${HTTP_BASE}/api/vault/media/${imgItem.id}`);
  assert.strictEqual(streamRes.status, 200);
  assert.strictEqual(streamRes.data.toString(), fakeEncryptedImg.toString());
  assert.strictEqual(streamRes.headers['accept-ranges'], 'bytes');
  assert.strictEqual(streamRes.headers['cache-control'], 'no-store, no-cache, must-revalidate');
  console.log('✓ Full binary stream verified with zero-disk cache-control headers');

  // 6. Test HTTP Range Streaming (ExoPlayer Seeking)
  console.log('[Test 6] Testing HTTP Range request (Partial Content 206 for video streaming)...');
  const rangeRes = await getBinary(`${HTTP_BASE}/api/vault/media/${vidItem.id}`, {
    'Range': 'bytes=0-99'
  });
  assert.strictEqual(rangeRes.status, 206, 'Must return HTTP 206 Partial Content');
  assert.strictEqual(rangeRes.data.length, 100);
  assert.ok(rangeRes.headers['content-range'].startsWith('bytes 0-99/'));
  console.log(`✓ HTTP Byte-Range partial stream verified: ${rangeRes.headers['content-range']}`);

  // 7. Test Delete & Multi-Device Sync
  console.log('[Test 7] Deleting item and verifying real-time sync across devices...');
  const delRes = await deleteRequest(`${HTTP_BASE}/api/vault/media/${imgItem.id}?mobile=${encodeURIComponent(testMobile)}`);
  assert.strictEqual(delRes.status, 200);
  assert.strictEqual(delRes.data.success, true);

  await sleep(200);
  assert.ok(devAReceivedVaultDelete, 'Device A must receive VAULT_ITEM_DELETED');
  assert.strictEqual(devAReceivedVaultDelete.itemId, imgItem.id);
  console.log(`✓ Deletion and sync confirmed: ${devAReceivedVaultDelete.itemId} purged from all devices`);

  // Close sockets
  devA.close();
  devB.close();

  if (serverProcess) {
    serverProcess.kill();
  }

  console.log('\n================================================================');
  console.log(' ALL 7 VAULT & MULTI-DEVICE VERIFICATION TESTS PASSED!');
  console.log('================================================================\n');
}

runVaultTests().catch(err => {
  console.error('Test Suite Failed:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
