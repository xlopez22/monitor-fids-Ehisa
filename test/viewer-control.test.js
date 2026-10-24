const test = require('node:test');
const assert = require('node:assert/strict');
const { ViewerControl } = require('../lib/viewer-control');

const ID = 'abcdefghijklmnop';
const OWNER = { ip: '10.0.0.10', sessionID: 'sesion-1' };

function fakeWs() {
  return { readyState: 1 }; // WebSocket.OPEN
}

test('registra el visor en solo lectura y lo encuentra para su dueño', () => {
  const viewers = new ViewerControl();
  const ws = fakeWs();
  const state = viewers.register(ID, { ...OWNER, ws });
  assert.equal(state.readOnly, true);
  assert.equal(viewers.find(ID, OWNER), state);
  assert.equal(viewers.size, 1);
});

test('no permite controlar desde otra IP u otra sesión', () => {
  const viewers = new ViewerControl();
  viewers.register(ID, { ...OWNER, ws: fakeWs() });
  assert.equal(viewers.find(ID, { ip: '10.0.0.11', sessionID: OWNER.sessionID }), null);
  assert.equal(viewers.find(ID, { ip: OWNER.ip, sessionID: 'otra' }), null);
  assert.equal(viewers.setReadOnly(ID, { ip: OWNER.ip, sessionID: 'otra' }, false), null);
});

test('activa y desactiva el control solo para la conexión viva', () => {
  const viewers = new ViewerControl();
  const ws = fakeWs();
  const state = viewers.register(ID, { ...OWNER, ws });
  assert.equal(viewers.setReadOnly(ID, OWNER, false), state);
  assert.equal(state.readOnly, false);

  ws.readyState = 3; // CLOSED
  assert.equal(viewers.find(ID, OWNER), null);
  assert.equal(viewers.setReadOnly(ID, OWNER, true), null);
});

test('remove no borra una conexión nueva que reutilice el id', () => {
  const viewers = new ViewerControl();
  const oldState = viewers.register(ID, { ...OWNER, ws: fakeWs() });
  const newState = viewers.register(ID, { ...OWNER, ws: fakeWs() });
  viewers.remove(ID, oldState);
  assert.equal(viewers.get(ID), newState);
  viewers.remove(ID, newState);
  assert.equal(viewers.get(ID), null);
});
