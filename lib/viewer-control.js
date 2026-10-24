// Registro de visores abiertos y su modo (solo lectura / control).
//
// El WebSocket de cada visor se registra al aceptar el upgrade con un id aleatorio
// que genera el navegador. Para activar el control, el cliente debe hacer un POST
// autenticado con ese id: así el servidor sabe que la intención viene de la misma
// sesión y de la misma conexión, y no de un mensaje RFB suelto.
class ViewerControl {
  constructor() {
    this.byConn = new Map();
  }

  register(connId, { ip, sessionID, ws }) {
    const state = { connId, ip, sessionID, ws, readOnly: true };
    this.byConn.set(connId, state);
    return state;
  }

  find(connId, { ip, sessionID }) {
    const state = this.byConn.get(connId);
    if (!state) return null;
    if (state.ip !== ip || state.sessionID !== sessionID) return null;
    if (state.ws.readyState !== 1) return null; // WebSocket.OPEN
    return state;
  }

  get(connId) {
    return this.byConn.get(connId) || null;
  }

  setReadOnly(connId, owner, readOnly) {
    const state = this.find(connId, owner);
    if (!state) return null;
    state.readOnly = Boolean(readOnly);
    return state;
  }

  // Se pasa el estado concreto para no borrar una conexión nueva que reutilice el id.
  remove(connId, state) {
    if (this.byConn.get(connId) === state) this.byConn.delete(connId);
  }

  get size() {
    return this.byConn.size;
  }
}

module.exports = { ViewerControl };
