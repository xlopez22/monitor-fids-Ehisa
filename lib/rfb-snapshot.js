// Cliente RFB mínimo que pide UN cuadro completo y lo devuelve como búfer RGB.
// Soporta ZRLE (lo que usa UltraVNC, bueno para pantallas 4K) y Raw como respaldo.
const zlib = require('zlib');
const { byteReader, handshakeServer } = require('./vnc-proxy');
const { createVncSocket } = require('./vnc-connect');

const ENC_RAW = 0;
const ENC_ZRLE = 16;

// Límites defensivos: un equipo VNC comprometido no debe poder agotar la memoria del panel
// anunciando una resolución, un nombre, un rectángulo o un ZRLE gigantes.
const MAX_WIDTH = 8192;
const MAX_HEIGHT = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;          // 4096x4096; un 4K vertical entra holgado
const MAX_DESKTOP_NAME = 4096;
const MAX_CUT_TEXT = 1024 * 1024;
const MAX_RECTS = 4096;
const MAX_ZRLE_BYTES = 32 * 1024 * 1024;
const MAX_RFB_BUFFER = MAX_PIXELS * 4 + 1024 * 1024;
const MAX_DECODED = MAX_PIXELS * 4 + 1024 * 1024;

function checkFrameSize(w, h) {
  if (!w || !h || w > MAX_WIDTH || h > MAX_HEIGHT || w * h > MAX_PIXELS) {
    throw new Error(`Resolución VNC fuera de límites: ${w}x${h}`);
  }
}

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
  const need = (n, what) => {
    if (n < 0 || off + n > src.length) throw new Error(`Datos ZRLE truncados (${what})`);
  };
  const put = (x, y, p) => {
    const o = ((rect.y + y) * fbW + rect.x + x) * 3;
    out[o] = src[p]; out[o + 1] = src[p + 1]; out[o + 2] = src[p + 2];
  };
  for (let ty = 0; ty < rect.h; ty += 64) {
    const th = Math.min(64, rect.h - ty);
    for (let tx = 0; tx < rect.w; tx += 64) {
      const tw = Math.min(64, rect.w - tx);
      need(1, 'subcodificación');
      const sub = src[off++];
      if (sub === 0) {                               // Raw
        need(tw * th * 3, 'raw');
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++, off += 3) put(tx + x, ty + y, off);
      } else if (sub === 1) {                        // Color sólido
        need(3, 'color sólido');
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) put(tx + x, ty + y, off);
        off += 3;
      } else if (sub >= 2 && sub <= 16) {            // Paleta empaquetada
        need(sub * 3, 'paleta');
        const pal = off; off += sub * 3;
        const bits = sub === 2 ? 1 : sub <= 4 ? 2 : 4;
        const mask = (1 << bits) - 1;
        need(Math.ceil((tw * th * bits) / 8), 'paleta empaquetada');
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
        if (sub >= 130) {
          need((sub - 128) * 3, 'paleta RLE');
          pal = off; off += (sub - 128) * 3;
        }
        let i = 0;
        const total = tw * th;
        while (i < total) {
          let p, run = 1;
          if (sub === 128) {
            need(3, 'RLE');
            p = off; off += 3;
            run = readRun();
          } else {
            need(1, 'índice RLE');
            const idx = src[off++];
            if ((idx & 127) >= sub - 128) throw new Error('Índice de paleta ZRLE fuera de rango');
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
    do {
      if (off >= src.length) throw new Error('Datos ZRLE truncados (longitud RLE)');
      b = src[off++];
      n += b;
    } while (b === 255);
    return n;
  }
}

async function readFrame(rd, sock, password) {
  await handshakeServer(rd, sock, password);
  sock.write(Buffer.from([1]));                      // ClientInit, sesión compartida
  const init = await rd.read(24);
  const w = init.readUInt16BE(0), h = init.readUInt16BE(2);
  checkFrameSize(w, h);
  const nameLen = init.readUInt32BE(20);
  if (nameLen > MAX_DESKTOP_NAME) throw new Error(`Nombre de escritorio VNC demasiado largo: ${nameLen} bytes`);
  await rd.read(nameLen);                            // nombre del escritorio
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
      const len = hdr.readUInt32BE(3);
      if (len > MAX_CUT_TEXT) throw new Error(`ServerCutText demasiado grande: ${len} bytes`);
      await rd.read(len);
      continue;
    }
    if (type !== 0) throw new Error(`Mensaje inesperado del servidor: ${type}`);
    const n = (await rd.read(3)).readUInt16BE(1);
    if (n > MAX_RECTS) throw new Error(`FramebufferUpdate con demasiados rectángulos: ${n}`);
    // Los datos ZRLE de todos los rectángulos son un mismo flujo zlib: se juntan y se descomprimen juntos
    const zrleRects = [];
    const chunks = [];
    let zrleBytes = 0;
    for (let i = 0; i < n; i++) {
      const r = await rd.read(12);
      const rect = { x: r.readUInt16BE(0), y: r.readUInt16BE(2), w: r.readUInt16BE(4), h: r.readUInt16BE(6) };
      const enc = r.readInt32BE(8);
      if (rect.x + rect.w > w || rect.y + rect.h > h) {
        throw new Error(`Rectángulo VNC fuera de pantalla: ${rect.x},${rect.y} ${rect.w}x${rect.h}`);
      }
      if (enc === ENC_ZRLE) {
        const len = (await rd.read(4)).readUInt32BE();
        if (len > MAX_ZRLE_BYTES - zrleBytes) throw new Error(`Datos ZRLE demasiado grandes: ${len} bytes`);
        zrleBytes += len;
        chunks.push(await rd.read(len));
        zrleRects.push(rect);
      } else if (enc === ENC_RAW) {
        const bytes = rect.w * rect.h * 4;
        if (bytes > MAX_PIXELS * 4) throw new Error(`Rectángulo VNC demasiado grande: ${bytes} bytes`);
        const px = await rd.read(bytes);
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
      const maxOut = Math.min(MAX_DECODED, w * h * 4 + 1024 * 1024);
      const data = zlib.inflateSync(Buffer.concat(chunks), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        maxOutputLength: maxOut,
      });
      let off = 0;
      for (const rect of zrleRects) off = decodeZrle(data, off, rect, out, w);
    }
    return { rgb: out, width: w, height: h };
  }
}

// Si no se logra abrir el TCP, el error lleva offline = true (el equipo no responde en el puerto VNC)
function grabFrame(host, port, password, { timeoutMs = 20000, connectTimeoutMs = 3000, tls = false, tlsCa, tlsInsecure = false, tlsServername } = {}) {
  return new Promise((resolve, reject) => {
    let sock;
    let readyEvent;
    try {
      ({ sock, readyEvent } = createVncSocket({
        host,
        port,
        useTls: tls,
        ca: tlsCa,
        rejectUnauthorized: !tlsInsecure,
        servername: tlsServername,
      }));
    } catch (e) {
      return reject(e);
    }
    const rd = byteReader({ maxBytes: MAX_RFB_BUFFER });
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
    sock.on('data', (d) => {
      try { rd.push(d); } catch (e) { fail(e.message); }
    });
    sock.on('error', (e) => fail(e.code || e.message));
    sock.on('close', () => fail('Conexión cerrada por el equipo'));
    sock.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
    });
    sock.once(readyEvent, () => {
      readFrame(rd, sock, password).then((v) => finish(null, v), finish);
    });
  });
}

module.exports = { grabFrame, decodeZrle };
