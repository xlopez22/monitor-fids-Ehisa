const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { jsonLimiter, FixedWindowLimiter, LIMITS } = require('../lib/rate-limit');

test('FixedWindowLimiter permite hasta el límite y después rechaza', () => {
  const l = new FixedWindowLimiter({ windowMs: 1000, limit: 3 });
  const now = 10_000;
  assert.equal(l.take('1.2.3.4', now).allowed, true);
  assert.equal(l.take('1.2.3.4', now).allowed, true);
  const third = l.take('1.2.3.4', now);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = l.take('1.2.3.4', now);
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterMs > 0);
});

test('FixedWindowLimiter separa IPs y reinicia al vencer la ventana', () => {
  const l = new FixedWindowLimiter({ windowMs: 1000, limit: 1 });
  assert.equal(l.take('a', 0).allowed, true);
  assert.equal(l.take('a', 1).allowed, false);
  assert.equal(l.take('b', 1).allowed, true);
  assert.equal(l.take('a', 1000).allowed, true);
});

test('FixedWindowLimiter no crece sin control si llegan muchas IPs', () => {
  const l = new FixedWindowLimiter({ windowMs: 1000, limit: 10, maxKeys: 5 });
  for (let i = 0; i < 50; i++) l.take(`ip-${i}`, 0);
  assert.ok(l.entries.size <= 6, `entradas: ${l.entries.size}`);
});

test('jsonLimiter responde 429 con JSON y deja pasar las primeras', async (t) => {
  const app = express();
  app.get('/test', jsonLimiter({ windowMs: 60_000, limit: 2 }), (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/test`;

  const r1 = await fetch(url);
  assert.equal(r1.status, 200);
  const r2 = await fetch(url);
  assert.equal(r2.status, 200);
  const r3 = await fetch(url);
  assert.equal(r3.status, 429);
  assert.match(r3.headers.get('content-type') || '', /application\/json/);
  const body = await r3.json();
  assert.match(body.error, /Demasiadas solicitudes/);
});

test('los límites de las rutas caras son más estrictos que la API general', () => {
  assert.ok(LIMITS.scan.limit < LIMITS.api.limit);
  assert.ok(LIMITS.import.limit < LIMITS.api.limit);
  assert.ok(LIMITS.refreshAll.limit < LIMITS.refresh.limit);
  assert.ok(LIMITS.ws.limit > 0);
});
