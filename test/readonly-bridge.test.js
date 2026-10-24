const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { bridge, byteReader } = require('../lib/vnc-proxy');

function fakeWs() {
  const handlers = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(data) { this.sent.push(Buffer.from(data)); },
    close(code, reason) {
      this.readyState = 3;
      this.closeCode = code;
      this.closeReason = reason;
    },
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    emit(event, data) { for (const fn of handlers[event] || []) fn(data); },
  };
}

function waitFor(check, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = check(); } catch (e) { return reject(e); }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('Tiempo de espera agotado'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function keyEvent() {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = 1;
  b.writeUInt32BE(0x61, 4);
  return b;
}
function pointerEvent() {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = 1;
  return b;
}
function setPixelFormat() {
  const b = Buffer.alloc(20);
  b[0] = 0;
  b[4] = 32;
  return b;
}
function fbRequest() {
  const b = Buffer.alloc(10);
  b[0] = 3;
  return b;
}

test('el puente arranca en solo lectura y solo reenvía entrada tras habilitar control', async (t) => {
  const post = [];
  let handshakeDone = false;
  let onCloseCalls = 0;
  let resolveOnClose;
  const onClose = new Promise((r) => { resolveOnClose = r; });
  const warnings = [];

  const server = net.createServer((sock) => {
    const rd = byteReader();
    sock.on('data', (d) => {
      if (handshakeDone) post.push(d);
      else rd.push(d);
    });
    (async () => {
      sock.write('RFB 003.008\n');
      await rd.read(12);
      sock.write(Buffer.from([1, 1])); // un tipo de seguridad: None
      await rd.read(1);
      sock.write(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
      await rd.read(1); // ClientInit
      const init = Buffer.alloc(24);
      init.writeUInt16BE(800, 0);
      init.writeUInt16BE(600, 2);
      sock.write(init); // ServerInit con nombre vacío
      const rest = rd.rest();
      handshakeDone = true;
      if (rest.length) post.push(rest);
    })().catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  const ws = fakeWs();
  const state = { readOnly: true };
  bridge(ws, {
    host: '127.0.0.1',
    port,
    password: '',
    controlState: state,
    log: { warn: (msg) => warnings.push(msg) },
    onClose: () => { onCloseCalls++; resolveOnClose(); },
  });

  // Handshake del navegador falso
  await waitFor(() => ws.sent.length >= 1);
  ws.emit('message', Buffer.from('RFB 003.008\n'));
  await waitFor(() => ws.sent.length >= 2);
  ws.emit('message', Buffer.from([1]));
  await waitFor(() => ws.sent.length >= 3);
  ws.emit('message', Buffer.from([1])); // ClientInit
  await waitFor(() => ws.sent.length >= 4); // ServerInit reenviado

  const safe = Buffer.concat([setPixelFormat(), fbRequest()]);
  const blocked = Buffer.concat([keyEvent(), pointerEvent()]);
  ws.emit('message', Buffer.concat([safe, blocked]));

  await waitFor(() => Buffer.concat(post).length >= safe.length);
  assert.deepEqual(Buffer.concat(post), safe);

  state.readOnly = false;
  ws.emit('message', keyEvent());
  await waitFor(() => Buffer.concat(post).length >= safe.length + 8);
  assert.deepEqual(Buffer.concat(post), Buffer.concat([safe, keyEvent()]));

  state.readOnly = true;
  const before = Buffer.concat(post).length;
  ws.emit('message', pointerEvent());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(Buffer.concat(post).length, before);

  ws.readyState = 3;
  ws.emit('close');
  await onClose;
  assert.equal(onCloseCalls, 1);
  assert.ok(warnings.some((w) => w.includes('solo lectura bloqueó')), 'debe registrar los eventos bloqueados');
});
