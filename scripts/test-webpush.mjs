// Verifies our Web Push encryption against the independent `http_ece` implementation
// (the one used by the reference `web-push` library), and the VAPID JWT signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { encryptPayload, vapidJwt, b64urlEncode, b64urlDecode } from '../supabase/functions/_shared/webpush.js';

const require = createRequire(import.meta.url);
const ece = require('http_ece');

test('aes128gcm payload decrypts with http_ece', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const message = JSON.stringify({ title: 'Where are you working today?', body: 'Ümlaut ✓' });
  const body = await encryptPayload(new TextEncoder().encode(message), b64urlEncode(ua.getPublicKey()), b64urlEncode(auth));
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.equal(plain.toString('utf8'), message);
});

test('VAPID JWT verifies with the public key', async () => {
  const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.webcrypto.subtle.exportKey('jwk', privateKey);
  const jwt = await vapidJwt('https://web.push.apple.com', 'https://example.com', jwk);
  const [h, p, s] = jwt.split('.');
  const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  assert.ok(ok);
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'https://web.push.apple.com');
});
