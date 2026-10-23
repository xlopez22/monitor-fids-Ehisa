// Servidor VNC mínimo para probar el monitor sin estar en la VLAN.
// Escucha en 0.0.0.0:<puerto>, así que 127.0.0.1, 127.0.0.2, ... responden como equipos distintos.
// Uso: node --openssl-legacy-provider test/fake-vnc-server.js <puerto> <contraseña>
const net = require('net');
const crypto = require('crypto');
const { vncAuthResponse } = require('../lib/vnc-proxy');

const PORT = Number(process.argv[2]) || 5901;
const PASSWORD = process.argv[3] || '';
const W = 1280, H = 720;

function hue(seed) {
  const h = (seed * 67) % 360;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function frame(addr, fmt) {
  const seed = Number(addr.split('.').pop());
  const [r0, g0, b0] = hue(seed);
  const t = Date.now() / 1000;
  const bar = Math.floor(((t % 4) / 4) * W);
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const shade = 0.4 + 0.6 * (y / H);
      let r = r0 * shade, g = g0 * shade, b = b0 * shade;
      if (Math.abs(x - bar) < 12) r = g = b = 255;
      // Bloque de "texto" con el último octeto para distinguir equipos
      if (y > 60 && y < 160 && x > 60 && x < 60 + seed * 8) r = g = b = 20;
      const px = ((r & 255) << fmt.r) | ((g & 255) << fmt.g) | ((b & 255) << fmt.b);
      buf.writeUInt32LE(px >>> 0, (y * W + x) * 4);
    }
  }
  return buf;
}

net.createServer((sock) => {
  const addr = sock.localAddress.replace('::ffff:', '');
  let buf = Buffer.alloc(0);
  let stage = 'version';
  let challenge;
  const fmt = { r: 16, g: 8, b: 0 };
  let encodings = [];
  let pendingTimer = null;

  const sendFrame = () => {
    pendingTimer = null;
    if (sock.destroyed) return;
    const hdr = Buffer.alloc(4 + 12);
    hdr.writeUInt8(0, 0);            // FramebufferUpdate
    hdr.writeUInt16BE(1, 2);         // 1 rectángulo
    hdr.writeUInt16BE(0, 4); hdr.writeUInt16BE(0, 6);
    hdr.writeUInt16BE(W, 8); hdr.writeUInt16BE(H, 10);
    const px = frame(addr, fmt);
    if (!encodings.includes(5)) {
      hdr.writeInt32BE(0, 12);       // Raw
      sock.write(Buffer.concat([hdr, px]));
      return;
    }
    hdr.writeInt32BE(5, 12);         // Hextile, cada tile de 16x16 con subcodificación Raw
    const parts = [hdr];
    for (let ty = 0; ty < H; ty += 16) {
      for (let tx = 0; tx < W; tx += 16) {
        const tw = Math.min(16, W - tx), th = Math.min(16, H - ty);
        const tile = Buffer.alloc(1 + tw * th * 4);
        tile[0] = 1;
        for (let y = 0; y < th; y++) {
          const start = ((ty + y) * W + tx) * 4;
          px.copy(tile, 1 + y * tw * 4, start, start + tw * 4);
        }
        parts.push(tile);
      }
    }
    sock.write(Buffer.concat(parts));
  };

  sock.on('error', () => {});
  sock.write('RFB 003.008\n');
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (stage === 'version') {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        sock.write(Buffer.from(PASSWORD ? [1, 2] : [1, 1]));
        stage = 'sectype';
      } else if (stage === 'sectype') {
        if (buf.length < 1) return;
        const t = buf[0]; buf = buf.subarray(1);
        if (t === 2) {
          challenge = crypto.randomBytes(16);
          sock.write(challenge);
          stage = 'auth';
        } else {
          sock.write(Buffer.from([0, 0, 0, 0]));
          stage = 'clientinit';
        }
      } else if (stage === 'auth') {
        if (buf.length < 16) return;
        const resp = buf.subarray(0, 16); buf = buf.subarray(16);
        if (!resp.equals(vncAuthResponse(challenge, PASSWORD))) {
          const reason = Buffer.from('Authentication failed');
          const out = Buffer.alloc(8); out.writeUInt32BE(1, 0); out.writeUInt32BE(reason.length, 4);
          sock.end(Buffer.concat([out, reason]));
          return;
        }
        sock.write(Buffer.from([0, 0, 0, 0]));
        stage = 'clientinit';
      } else if (stage === 'clientinit') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        const name = Buffer.from(`FAKE ${addr}`);
        const init = Buffer.alloc(24);
        init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2);
        init.writeUInt8(32, 4); init.writeUInt8(24, 5); init.writeUInt8(0, 6); init.writeUInt8(1, 7);
        init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
        init.writeUInt8(16, 14); init.writeUInt8(8, 15); init.writeUInt8(0, 16);
        init.writeUInt32BE(name.length, 20);
        sock.write(Buffer.concat([init, name]));
        stage = 'normal';
      } else {
        if (buf.length < 1) return;
        const type = buf[0];
        const need = { 0: 20, 3: 10, 4: 8, 5: 6 }[type]
          ?? (type === 2 ? (buf.length >= 4 ? 4 + buf.readUInt16BE(2) * 4 : Infinity)
          : type === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : 1);
        if (buf.length < need) return;
        const msg = buf.subarray(0, need); buf = buf.subarray(need);
        if (type === 0) { fmt.r = msg[14]; fmt.g = msg[15]; fmt.b = msg[16]; }
        if (type === 2) encodings = Array.from({ length: msg.readUInt16BE(2) }, (_, i) => msg.readInt32BE(4 + i * 4));
        if (type === 3 && !pendingTimer) {
          // Incremental: se responde con ~2 cuadros por segundo para simular movimiento
          pendingTimer = setTimeout(sendFrame, msg[1] ? 500 : 0);
        }
      }
    }
  });
  sock.on('close', () => clearTimeout(pendingTimer));
}).listen(PORT, '0.0.0.0', () => console.log(`VNC falso en 0.0.0.0:${PORT}`));
