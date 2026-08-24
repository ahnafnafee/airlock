import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffURL, launchFiles, receiveHandoff } from './handoff.js';

const ORIGIN = 'https://airlock.example:8443';
const TOKEN = '6c14'.repeat(16);
const BRIDGE = `http://127.0.0.1:54321/airlock-handoff/${TOKEN}`;
const TARGET = `${ORIGIN}/?handoff=${encodeURIComponent(BRIDGE)}`;

test('a launch target accepts only the one-shot Airlock loopback shape', () => {
  assert.equal(handoffURL(TARGET, ORIGIN), BRIDGE);

  const refused = [
    `https://other.example/?handoff=${encodeURIComponent(BRIDGE)}`,
    `${ORIGIN}/?handoff=${encodeURIComponent(`http://localhost:54321/airlock-handoff/${TOKEN}`)}`,
    `${ORIGIN}/?handoff=${encodeURIComponent(`https://127.0.0.1:54321/airlock-handoff/${TOKEN}`)}`,
    `${ORIGIN}/?handoff=${encodeURIComponent('http://127.0.0.1:54321/not-airlock/' + TOKEN)}`,
    `${ORIGIN}/?handoff=${encodeURIComponent(BRIDGE + '?again=1')}`,
    `${TARGET}&handoff=${encodeURIComponent(BRIDGE)}`,
  ];
  for (const target of refused) assert.equal(handoffURL(target, ORIGIN), null, target);
});

test('a loopback handoff is a preflighted POST and keeps the original filename', async () => {
  const bytes = new TextEncoder().encode('patch bytes');
  const filename = Buffer.from('ahnafnafee-patches-0.3.3.mpp')
    .toString('base64url');
  let requested;

  const file = await receiveHandoff(BRIDGE, {
    fetch: async (url, init) => {
      requested = { url, init };
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Airlock-Handoff': TOKEN,
          'X-Airlock-Name': filename,
          'X-Airlock-Modified': '1787529600123',
        },
      });
    },
  });

  assert.equal(requested.url, BRIDGE);
  assert.equal(requested.init.method, 'POST');
  assert.equal(requested.init.headers['X-Airlock-Handoff'], TOKEN);
  assert.equal(requested.init.credentials, 'omit');
  assert.equal(requested.init.redirect, 'error');
  assert.equal(requested.init.referrerPolicy, 'no-referrer');
  assert.equal('targetAddressSpace' in requested.init, false,
    '127.0.0.1 is already classified as loopback; overriding it makes Chrome reject the request');
  assert.equal(file.name, 'ahnafnafee-patches-0.3.3.mpp');
  assert.equal(file.type, 'application/octet-stream');
  assert.equal(file.lastModified, 1787529600123);
  assert.equal(await file.text(), 'patch bytes');
});

test('a response that does not prove it is the selected bridge is refused', async () => {
  await assert.rejects(
    receiveHandoff(BRIDGE, {
      fetch: async () => new Response('not a bridge', {
        headers: { 'X-Airlock-Name': Buffer.from('wrong.mpp').toString('base64url') },
      }),
    }),
    /did not identify itself/i,
  );
});

test('launch payloads preserve native file handles and also accept target URLs', async () => {
  const native = new File(['native'], 'declared.md');
  const fromHandle = await launchFiles({
    files: [{ getFile: async () => native }],
    targetURL: `${ORIGIN}/open`,
  }, { origin: ORIGIN });
  assert.deepEqual(fromHandle, [native]);

  const bridged = new File(['bridge'], 'anything.mpp');
  let received;
  const fromTarget = await launchFiles({ targetURL: TARGET }, {
    origin: ORIGIN,
    receive: async (url) => { received = url; return bridged; },
  });
  assert.equal(received, BRIDGE);
  assert.deepEqual(fromTarget, [bridged]);

  assert.deepEqual(await launchFiles({ targetURL: `${ORIGIN}/` }, {
    origin: ORIGIN,
    receive: async () => { throw new Error('must not fetch'); },
  }), []);
});
