// Cliente RFB mínimo que pide UN cuadro completo y lo devuelve como búfer RGB.
// Soporta ZRLE (lo que usa UltraVNC, bueno para pantallas 4K) y Raw como respaldo.
const net = require('net');
const zlib = require('zlib');
const { byteReader, handshakeServer } = require('./vnc-proxy');

const ENC_RAW = 0;
const ENC_ZRLE = 16;

// Formato de píxel pedido al servidor: 32 bpp, little-endian, R en el byte 0, G en 1, B en 2.
// Así un CPIXEL de ZRLE son exactamente 3 bytes R,G,B.
function setPixelFormatMsg() {
  const m = Buffer.alloc(20);
  m[0] = 0;                 // SetPixelFormat
  m[4] = 32; m[5] = 24;     // bpp, depth
  m[6] = 0; m[7] = 1;       // little-endian, true color
  m.writeUInt16BE(255, 8); m.writeUInt16BE(255, 10); m.writeUInt16BE(255, 12);
  m[14] = 0; m[15] = 8; m[16] = 16;
  return m;
}

function setEncodingsMsg(encs) {
  const m = Buffer.alloc(4 + encs.length * 4);
  m[0] = 2;
  m.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => m.writeInt32BE(e, 4 + i * 4));
  return m;
}

function fbRequestMsg(w, h) {
  const m = Buffer.alloc(10);
  m[0] = 3; m[1] = 0;       // no incremental: cuadro completo
  m.writeUInt16BE(w, 6); m.writeUInt16BE(h, 8);
  return m;
}

// Decodifica los tiles ZRLE (64x64) de un rectángulo ya descomprimido
function decodeZrle(src, off, rect, out, fbW) {
  const put = (x, y, p) => {
    const o = ((rect.y + y) * fbW + rect.x + x) * 3;
    out[o] = src[p]; out[o + 1] = src[p + 1]; out[o + 2] = src[p + 2];
  };
  for (let ty = 0; ty < rect.h; ty += 64) {
    const th = Math.min(64, rect.h - ty);
    for (let tx = 0; tx < rect.w; tx += 64) {
      const tw = Math.min(64, rect.w - tx);
      const sub = src[off++];
      if (sub === 0) {                               // Raw
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++, off += 3) put(tx + x, ty + y, off);
      } else if (sub === 1) {                        // Color sólido
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) put(tx + x, ty + y, off);
        off += 3;
      } else if (sub >= 2 && sub <= 16) {            // Paleta empaquetada
        const pal = off; off += sub * 3;
        const bits = sub === 2 ? 1 : sub <= 4 ? 2 : 4;
        const mask = (1 << bits) - 1;
        for (let y = 0; y < th; y++) {
          let byte = 0, left = 0;
          for (let x = 0; x < tw; x++) {
            if (left === 0) { byte = src[off++]; left = 8; }
            left -= bits;
            put(tx + x, ty + y, pal + ((byte >> left) & mask) * 3);
          }
        }
      } else if (sub === 128 || sub >= 130) {        // RLE simple / RLE con paleta
        let pal = 0;
        if (sub >= 130) { pal = off; off += (sub - 128) * 3; }
        let i = 0;
        const total = tw * th;
        while (i < total) {
          let p, run = 1;
          if (sub === 128) {
            p = off; off += 3;
            run = readRun();
          } else {
            const idx = src[off++];
            p = pal + (idx & 127) * 3;
            if (idx & 128) run = readRun();
          }
          for (let k = 0; k < run && i < total; k++, i++) put(tx + (i % tw), ty + Math.floor(i / tw), p);
        }
      } else {
        throw new Error(`Subcodificación ZRLE no válida: ${sub}`);
      }
    }
  }
  return off;

  function readRun() {
    let n = 1, b;
    do { b = src[off++]; n += b; } while (b === 255);
    return n;
  }
}

async function readFrame(rd, sock, password) {
  await handshakeServer(rd, sock, password);
  sock.write(Buffer.from([1]));                      // ClientInit, sesión compartida
  const init = await rd.read(24);
  const w = init.readUInt16BE(0), h = init.readUInt16BE(2);
  await rd.read(init.readUInt32BE(20));              // nombre del escritorio
  sock.write(Buffer.concat([setPixelFormatMsg(), setEncodingsMsg([ENC_ZRLE, ENC_RAW])]));
  // UltraVNC ignora a veces una petición que llega pegada al ClientInit: se espera 1 s
  // y se repite cada 3 s hasta que empiece a llegar el cuadro
  const ask = () => sock.write(fbRequestMsg(w, h));
  let retry;
  const first = setTimeout(() => { ask(); retry = setInterval(ask, 3000); }, 1000);
  const stopAsking = () => { clearTimeout(first); clearInterval(retry); };

  const out = Buffer.alloc(w * h * 3);
  for (;;) {
    const type = (await rd.read(1).finally(stopAsking))[0];
    if (type === 2) continue;                        // Bell
    if (type === 3) {                                // ServerCutText
      const hdr = await rd.read(7);
      await rd.read(hdr.readUInt32BE(3));
      continue;
    }
    if (type !== 0) throw new Error(`Mensaje inesperado del servidor: ${type}`);
    const n = (await rd.read(3)).readUInt16BE(1);
    // Los datos ZRLE de todos los rectángulos son un mismo flujo zlib: se juntan y se descomprimen juntos
    const zrleRects = [];
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const r = await rd.read(12);
      const rect = { x: r.readUInt16BE(0), y: r.readUInt16BE(2), w: r.readUInt16BE(4), h: r.readUInt16BE(6) };
      const enc = r.readInt32BE(8);
      if (enc === ENC_ZRLE) {
        const len = (await rd.read(4)).readUInt32BE();
        chunks.push(await rd.read(len));
        zrleRects.push(rect);
      } else if (enc === ENC_RAW) {
        const px = await rd.read(rect.w * rect.h * 4);
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            const s = (y * rect.w + x) * 4, o = ((rect.y + y) * w + rect.x + x) * 3;
            out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2];
          }
        }
      } else {
        throw new Error(`Codificación no soportada: ${enc}`);
      }
    }
    if (chunks.length) {
      const data = zlib.inflateSync(Buffer.concat(chunks), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      let off = 0;
      for (const rect of zrleRects) off = decodeZrle(data, off, rect, out, w);
    }
    return { rgb: out, width: w, height: h };
  }
}

// Si no se logra abrir el TCP, el error lleva offline = true (el equipo no responde en el puerto VNC)
function grabFrame(host, port, password, { timeoutMs = 20000, connectTimeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const rd = byteReader();
    let done = false;
    let connected = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      sock.destroy();
      if (err) err.offline = !connected;
      err ? reject(err) : resolve(val);
    };
    const fail = (msg) => { const e = new Error(msg); rd.fail(e); finish(e); };
    const connectTimer = setTimeout(() => fail('Sin respuesta en el puerto VNC'), connectTimeoutMs);
    const timer = setTimeout(() => fail('Tiempo de espera agotado'), timeoutMs);
    sock.on('data', (d) => rd.push(d));
    sock.on('error', (e) => fail(e.code || e.message));
    sock.on('close', () => fail('Conexión cerrada por el equipo'));
    sock.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      readFrame(rd, sock, password).then((v) => finish(null, v), finish);
    });
  });
}

module.exports = { grabFrame, decodeZrle };
