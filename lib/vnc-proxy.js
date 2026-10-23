// Puente WebSocket (noVNC en el navegador) <-> TCP (UltraVNC en el equipo).
// La autenticación VNC se hace aquí, en el servidor: el navegador nunca ve la contraseña
// y negocia con el proxy un acceso "sin contraseña" que solo existe en 127.0.0.1.
const net = require('net');
const crypto = require('crypto');

// Lector de bytes exactos sobre un flujo que llega en pedazos
function byteReader() {
  let buf = Buffer.alloc(0);
  let pending = null;
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
    push(data) { buf = Buffer.concat([buf, data]); pump(); },
    read(n) { return new Promise((resolve, reject) => { pending = { n, resolve, reject }; pump(); }); },
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

  const readReason = async () => (await rd.read((await rd.read(4)).readUInt32BE())).toString();
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

function bridge(ws, { host, port, password, timeoutMs = 10000, connectTimeoutMs = 4000, log = console, onError = () => {} }) {
  const tcp = net.connect({ host, port });
  // Windows tarda ~21 s en dar por perdida una conexión TCP: se corta antes para avisar rápido
  const connectTimer = setTimeout(() => close('Sin respuesta en el puerto VNC (equipo caído o apagado)'), connectTimeoutMs);
  tcp.once('connect', () => clearTimeout(connectTimer));
  const fromServer = byteReader();
  const fromBrowser = byteReader();
  let piping = false;

  const close = (why) => {
    if (why) {
      log.warn(`[vnc ${host}] ${why}`);
      if (!piping) onError(why); // solo errores de conexión/autenticación, no cierres normales
    }
    clearTimeout(connectTimer);
    tcp.destroy();
    if (ws.readyState === ws.OPEN) ws.close(1011, String(why || '').slice(0, 120));
  };

  tcp.setTimeout(timeoutMs, () => { if (!piping) close('Tiempo de espera agotado'); });
  tcp.on('error', (e) => { fromServer.fail(e); close(e.code || e.message); });
  tcp.on('close', () => { fromServer.fail(new Error('cerrado')); close(); });
  tcp.on('data', (d) => (piping ? ws.send(d) : fromServer.push(d)));

  ws.on('message', (d) => (piping ? tcp.write(d) : fromBrowser.push(Buffer.from(d))));
  ws.on('close', () => { clearTimeout(connectTimer); fromBrowser.fail(new Error('navegador cerró')); tcp.destroy(); });

  (async () => {
    await new Promise((res, rej) => { tcp.once('connect', res); tcp.once('error', rej); });
    await handshakeServer(fromServer, tcp, password);
    await handshakeBrowser(fromBrowser, (b) => ws.send(b));
    // A partir de aquí todo pasa tal cual; primero lo que haya quedado en búfer
    piping = true;
    tcp.setTimeout(0);
    const b = fromBrowser.rest();
    if (b.length) tcp.write(b);
    const s = fromServer.rest();
    if (s.length) ws.send(s);
  })().catch((e) => close(e.message));
}

module.exports = { bridge, vncAuthResponse, byteReader, handshakeServer };
