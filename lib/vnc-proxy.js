// Puente WebSocket (noVNC en el navegador) <-> TCP (UltraVNC en el equipo).
// La autenticación VNC se hace aquí, en el servidor: el navegador nunca ve la contraseña
// y negocia con el proxy un acceso "sin contraseña" que solo existe en 127.0.0.1.
const crypto = require('crypto');
const { createVncSocket } = require('./vnc-connect');
const { createClientFilter } = require('./rfb-client-filter');

const MAX_HANDSHAKE_BUFFER = 1024 * 1024;

// Lector de bytes exactos sobre un flujo que llega en pedazos.
// maxBytes limita tanto lo que se puede acumular como lo que se puede pedir de una vez:
// así un equipo (o un navegador) que anuncie una longitud absurda no agota la memoria.
function byteReader({ maxBytes = 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0);
  let pending = null;
  const tooBig = (n) => new Error(`Búfer de protocolo demasiado grande: ${n} bytes (máximo ${maxBytes})`);
  const pump = () => {
    if (pending && buf.length >= pending.n) {
      const out = buf.subarray(0, pending.n);
      buf = buf.subarray(pending.n);
      const p = pending;
      pending = null;
      p.resolve(out);
    }
  };
  return {
    push(data) {
      if (buf.length + data.length > maxBytes) throw tooBig(buf.length + data.length);
      buf = Buffer.concat([buf, data]);
      pump();
    },
    read(n) {
      if (!Number.isInteger(n) || n < 0 || n > maxBytes) {
        return Promise.reject(new Error(`Lectura de protocolo inválida: ${n} bytes (máximo ${maxBytes})`));
      }
      return new Promise((resolve, reject) => { pending = { n, resolve, reject }; pump(); });
    },
    fail(err) { if (pending) { pending.reject(err); pending = null; } },
    rest() { const r = buf; buf = Buffer.alloc(0); return r; },
  };
}

function vncAuthResponse(challenge, password) {
  // VNC usa DES con los bits de cada byte de la clave invertidos (máx. 8 caracteres)
  const key = Buffer.alloc(8);
  key.write(password.slice(0, 8), 'latin1');
  for (let i = 0; i < 8; i++) {
    let b = key[i], r = 0;
    for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; }
    key[i] = r;
  }
  const des = crypto.createCipheriv('des-ecb', key, null);
  des.setAutoPadding(false);
  return Buffer.concat([des.update(challenge), des.final()]);
}

// Completa el saludo RFB con el equipo real hasta dejarlo esperando ClientInit
async function handshakeServer(rd, sock, password) {
  const ver = (await rd.read(12)).toString('latin1');
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(ver);
  if (!m) throw new Error(`Respuesta no es VNC: ${JSON.stringify(ver)}`);
  const minor = Number(m[1]) > 3 ? 8 : Math.min(Number(m[2]), 8);
  const v = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
  sock.write(`RFB 003.00${v}\n`);

  const readReason = async () => {
    const len = (await rd.read(4)).readUInt32BE();
    if (len > 4096) throw new Error(`Motivo VNC demasiado largo: ${len} bytes`);
    return (await rd.read(len)).toString();
  };
  let type;
  if (v === 3) {
    type = (await rd.read(4)).readUInt32BE();
    if (type === 0) throw new Error(await readReason());
  } else {
    const count = (await rd.read(1))[0];
    if (count === 0) throw new Error(await readReason());
    const types = [...(await rd.read(count))];
    if (types.includes(2) && password) type = 2;
    else if (types.includes(1)) type = 1;
    else throw new Error(`Tipos de seguridad no soportados: ${types.join(',')}`);
    sock.write(Buffer.from([type]));
  }

  if (type === 2) {
    if (!password) throw new Error('El equipo pide contraseña y VNC_PASSWORD está vacío');
    sock.write(vncAuthResponse(await rd.read(16), password));
  }
  if (type === 2 || v === 8) {
    const result = (await rd.read(4)).readUInt32BE();
    if (result !== 0) throw new Error(v === 8 ? `Autenticación rechazada: ${await readReason()}` : 'Contraseña VNC rechazada');
  }
}

// Saludo con el navegador: RFB 3.8 con seguridad "None"
async function handshakeBrowser(rd, send) {
  send(Buffer.from('RFB 003.008\n'));
  await rd.read(12);
  send(Buffer.from([1, 1]));
  const chosen = (await rd.read(1))[0];
  if (chosen !== 1) throw new Error('El navegador eligió un tipo de seguridad inesperado');
  send(Buffer.from([0, 0, 0, 0]));
}

function bridge(ws, {
  host, port, password,
  tls = false, tlsCa, tlsInsecure = false, tlsServername,
  readOnly = true, controlState = null,
  timeoutMs = 10000, connectTimeoutMs = 4000,
  log = console, onError = () => {}, onClose = () => {},
}) {
  let conn;
  try {
    conn = createVncSocket({
      host,
      port,
      useTls: tls,
      ca: tlsCa,
      rejectUnauthorized: !tlsInsecure,
      servername: tlsServername,
    });
  } catch (e) {
    log.warn(`[vnc ${host}] ${e.message}`);
    onError(e.message);
    if (ws.readyState === ws.OPEN) ws.close(1011, String(e.message).slice(0, 120));
    onClose();
    return;
  }
  const { sock: tcp, readyEvent } = conn;
  // Windows tarda ~21 s en dar por perdida una conexión TCP: se corta antes para avisar rápido
  const connectTimer = setTimeout(() => close('Sin respuesta en el puerto VNC (equipo caído o apagado)'), connectTimeoutMs);
  tcp.once(readyEvent, () => clearTimeout(connectTimer));
  const fromServer = byteReader({ maxBytes: MAX_HANDSHAKE_BUFFER });
  const fromBrowser = byteReader({ maxBytes: MAX_HANDSHAKE_BUFFER });
  const filter = createClientFilter();
  const isReadOnly = () => (controlState ? controlState.readOnly : readOnly);
  let piping = false;
  let closed = false;

  const close = (why) => {
    if (closed) return;
    closed = true;
    if (why) {
      log.warn(`[vnc ${host}] ${why}`);
      if (!piping) onError(why); // solo errores de conexión/autenticación, no cierres normales
    }
    clearTimeout(connectTimer);
    const b = filter.blocked;
    if (b.key || b.pointer || b.clipboard || b.other) {
      const parts = [];
      if (b.key) parts.push(`${b.key} tecla(s)`);
      if (b.pointer) parts.push(`${b.pointer} puntero(s)`);
      if (b.clipboard) parts.push(`${b.clipboard} portapapeles`);
      if (b.other) parts.push(`${b.other} otro(s)`);
      log.warn(`[vnc ${host}] solo lectura bloqueó ${parts.join(', ')}`);
    }
    tcp.destroy();
    if (ws.readyState === ws.OPEN) ws.close(1011, String(why || '').slice(0, 120));
    onClose();
  };

  // Todo lo que manda el navegador después del handshake pasa por el filtro.
  const feedBrowser = (data) => {
    if (closed) return;
    try {
      const out = filter.push(data, isReadOnly());
      if (out.length) tcp.write(out);
    } catch (e) {
      onError(e.message);
      close(`Protocolo VNC inválido: ${e.message}`);
    }
  };

  tcp.setTimeout(timeoutMs, () => { if (!piping) close('Tiempo de espera agotado'); });
  tcp.on('error', (e) => { fromServer.fail(e); close(e.code || e.message); });
  tcp.on('close', () => { fromServer.fail(new Error('cerrado')); close(); });
  tcp.on('data', (d) => {
    if (closed) return;
    if (piping) {
      if (ws.readyState === ws.OPEN) ws.send(d);
    } else {
      try { fromServer.push(d); } catch (e) { close(e.message); }
    }
  });

  ws.on('message', (d) => {
    if (closed) return;
    if (!piping) {
      try { fromBrowser.push(Buffer.from(d)); } catch (e) { close(e.message); }
    } else {
      feedBrowser(Buffer.from(d));
    }
  });
  ws.on('close', () => {
    fromBrowser.fail(new Error('navegador cerró'));
    close();
  });

  (async () => {
    await new Promise((res, rej) => { tcp.once(readyEvent, res); tcp.once('error', rej); });
    await handshakeServer(fromServer, tcp, password);
    await handshakeBrowser(fromBrowser, (b) => ws.send(b));
    // ClientInit es un byte suelto, no un mensaje RFB: se aparta antes de activar el filtro.
    const clientInit = await fromBrowser.read(1);
    if (clientInit[0] !== 0 && clientInit[0] !== 1) throw new Error('ClientInit inválido');
    tcp.write(clientInit);
    // A partir de aquí todo pasa por el filtro; primero lo que haya quedado en búfer.
    piping = true;
    tcp.setTimeout(0);
    const b = fromBrowser.rest();
    if (b.length) feedBrowser(b);
    if (closed) return;
    const s = fromServer.rest();
    if (s.length) ws.send(s);
  })().catch((e) => close(e.message));
}

module.exports = { bridge, vncAuthResponse, byteReader, handshakeServer };
