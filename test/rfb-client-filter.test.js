const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientFilter } = require('../lib/rfb-client-filter');

function setPixelFormat() {
  const b = Buffer.alloc(20);
  b[0] = 0;
  b[4] = 32;
  return b;
}
function setEncodings(count = 2) {
  const b = Buffer.alloc(4 + 4 * count);
  b[0] = 2;
  b.writeUInt16BE(count, 2);
  for (let i = 0; i < count; i++) b.writeInt32BE(i, 4 + 4 * i);
  return b;
}
function fbRequest() {
  const b = Buffer.alloc(10);
  b[0] = 3;
  return b;
}
function keyEvent() {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = 1;
  b.writeUInt32BE(0x61, 4);
  return b;
}
function pointerEvent(extended = false) {
  const b = Buffer.alloc(extended ? 7 : 6);
  b[0] = 5;
  b[1] = extended ? 0x81 : 0x01;
  return b;
}
function cutText(text, extended = false) {
  const data = Buffer.from(text);
  const b = Buffer.alloc(8 + data.length);
  b[0] = 6;
  b.writeInt32BE(extended ? -data.length : data.length, 4);
  data.copy(b, 8);
  return b;
}
function qemuKey() {
  const b = Buffer.alloc(12);
  b[0] = 255;
  b[1] = 0;
  return b;
}
function continuousUpdates() {
  const b = Buffer.alloc(10);
  b[0] = 150;
  return b;
}
function clientFence() {
  const b = Buffer.alloc(12);
  b[0] = 248;
  b[8] = 3;
  return b;
}
function desktopSize() {
  const b = Buffer.alloc(8 + 16);
  b[0] = 251;
  b[6] = 1;
  return b;
}
function xvpOp() {
  return Buffer.from([250, 0, 1, 2]);
}

test('solo lectura permite SetPixelFormat, SetEncodings y FramebufferUpdateRequest', () => {
  const f = createClientFilter();
  const safe = Buffer.concat([setPixelFormat(), setEncodings(), fbRequest()]);
  assert.deepEqual(f.push(safe, true), safe);
  assert.equal(f.pending(), 0);
  assert.deepEqual(f.blocked, { key: 0, pointer: 0, clipboard: 0, other: 0 });
});

test('solo lectura bloquea teclado, puntero, portapapeles y extensiones', () => {
  const f = createClientFilter();
  const blocked = Buffer.concat([
    keyEvent(),
    pointerEvent(),
    cutText('hola'),
    qemuKey(),
    continuousUpdates(),
    clientFence(),
    desktopSize(),
    xvpOp(),
  ]);
  assert.equal(f.push(blocked, true).length, 0);
  assert.deepEqual(f.blocked, { key: 2, pointer: 1, clipboard: 1, other: 4 });
});

test('procesa mensajes partidos byte a byte', () => {
  const f = createClientFilter();
  const input = Buffer.concat([
    setPixelFormat(),
    keyEvent(),
    fbRequest(),
    pointerEvent(true),
    cutText('abc', true),
  ]);
  const out = [];
  for (const byte of input) {
    const chunk = f.push(Buffer.from([byte]), true);
    if (chunk.length) out.push(chunk);
  }
  assert.deepEqual(Buffer.concat(out), Buffer.concat([setPixelFormat(), fbRequest()]));
  assert.deepEqual(f.blocked, { key: 1, pointer: 1, clipboard: 1, other: 0 });
  assert.equal(f.pending(), 0);
});

test('varios mensajes en un mismo frame: reenvía solo los seguros', () => {
  const f = createClientFilter();
  const safe1 = setPixelFormat();
  const safe2 = fbRequest();
  const input = Buffer.concat([safe1, keyEvent(), pointerEvent(), safe2]);
  assert.deepEqual(f.push(input, true), Buffer.concat([safe1, safe2]));
});

test('en modo control reenvía todo, incluido teclado y portapapeles', () => {
  const f = createClientFilter();
  const input = Buffer.concat([setPixelFormat(), keyEvent(), pointerEvent(true), cutText('texto', true), xvpOp(), fbRequest()]);
  assert.deepEqual(f.push(input, false), input);
  assert.deepEqual(f.blocked, { key: 0, pointer: 0, clipboard: 0, other: 0 });
});

test('un mensaje incompleto queda pendiente y no se reenvía', () => {
  const f = createClientFilter();
  const key = keyEvent();
  assert.equal(f.push(key.subarray(0, 3), true).length, 0);
  assert.equal(f.pending(), 3);
  assert.equal(f.push(key.subarray(3), true).length, 0);
  assert.equal(f.pending(), 0);
  assert.equal(f.blocked.key, 1);
});

test('un tipo desconocido cierra el flujo con error', () => {
  const f = createClientFilter();
  assert.throws(() => f.push(Buffer.from([99]), true), /no soportado: tipo 99/);
});

test('un ClientCutText gigante se rechaza antes de reservar memoria', () => {
  const f = createClientFilter();
  const b = Buffer.alloc(8);
  b[0] = 6;
  b.writeInt32BE(17 * 1024 * 1024, 4);
  assert.throws(() => f.push(b, true), /ClientCutText de/);
});

test('el portapapeles extendido usa la longitud absoluta', () => {
  const f = createClientFilter();
  f.push(cutText('abc', true), true);
  assert.deepEqual(f.push(fbRequest(), true), fbRequest());
  assert.equal(f.blocked.clipboard, 1);
});

test('el puntero extendido usa el bit marcador para medir 7 bytes', () => {
  const f = createClientFilter();
  f.push(pointerEvent(true), true);
  assert.deepEqual(f.push(fbRequest(), true), fbRequest());
  assert.equal(f.blocked.pointer, 1);
});
