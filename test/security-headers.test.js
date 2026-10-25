const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { buildCsp, wsOrigins, securityHeaders } = require('../lib/security-headers');
const { Store } = require('../lib/store');

test('la CSP no permite scripts inline ni objetos y limita la conexión al panel', () => {
  const csp = buildCsp(['http://127.0.0.1:8080', 'https://fids.local']);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:8080 wss:\/\/fids\.local/);
});

test('wsOrigins ignora orígenes inválidos y convierte http/https', () => {
  assert.deepEqual(
    wsOrigins(['http://a.local:8080', 'https://b.local', 'no-es-url', 'ftp://c.local']),
    ['ws://a.local:8080', 'wss://b.local'],
  );
});

test('securityHeaders aplica CSP y cabeceras defensivas', async (t) => {
  const app = express();
  app.use(securityHeaders({ origins: ['http://127.0.0.1:8080'] }));
  app.get('/', (req, res) => res.type('html').send('ok'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/);
});

test('Store solo acepta zonas conocidas y no confía en la etiqueta del cliente', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fids-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'inventory.json'));

  const d = store.clean({
    name: 'SAP-CK-01',
    ip: '192.168.10.10',
    group: 'CK',
    groupLabel: '<img src=x onerror=alert(1)>',
  });
  assert.equal(d.group, 'CK');
  assert.equal(d.groupLabel, 'Check-in');

  assert.throws(
    () => store.clean({ name: 'SAP-X', ip: '192.168.10.11', group: '<img>', groupLabel: 'x' }),
    /Zona no válida/,
  );
});
