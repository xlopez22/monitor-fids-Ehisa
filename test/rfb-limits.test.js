const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const zlib = require('node:zlib');
const { grabFrame, decodeZrle } = require('../lib/rfb-snapshot');
const { byteReader } = require('../lib/vnc-proxy');

const OPTS = { timeoutMs: 1500, connectTimeoutMs: 500 };

// Servidor VNC falso que completa el handshake y deja que cada prueba envíe
// el mensaje malicioso después del ServerInit.
function startSnapshotServer(t, { width = 800, height = 600, nameLength = 0, afterInit = () => {} }) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'version';
    sock.write('RFB 003.008\n');
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 1])); // seguridad None
          stage = 'sectype';
        } else if (stage === 'sectype') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(Buffer.from([0, 0, 0, 0]));
          stage = 'clientinit';
        } else if (stage === 'clientinit') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const init = Buffer.alloc(24);
          init.writeUInt16BE(width, 0);
          init.writeUInt16BE(height, 2);
          init.writeUInt32BE(nameLength, 20);
          sock.write(init);
          stage = 'normal';
          afterInit(sock);
        } else {
          return; // los mensajes del cliente no importan para estas pruebas
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        for (const s of sockets) s.destroy();
        server.close(done);
      }));
      resolve(server.address().port);
    });
  });
}

function framebufferUpdate(rects) {
  const head = Buffer.alloc(4);
  head[0] = 0;
  head.writeUInt16BE(rects.length, 2);
  return Buffer.concat([head, ...rects]);
}

function rectMsg({ x = 0, y = 0, w = 0, h = 0, enc = 0 } = {}) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b.writeUInt16BE(w, 4);
  b.writeUInt16BE(h, 6);
  b.writeInt32BE(enc, 8);
  return b;
}

test('byteReader limita lo acumulado y lo que se puede pedir', async () => {
  const rd = byteReader({ maxBytes: 8 });
  assert.throws(() => rd.push(Buffer.alloc(9)), /demasiado grande/);
  await assert.rejects(rd.read(9), /Lectura de protocolo inválida/);
  rd.push(Buffer.from([1, 2, 3]));
  assert.deepEqual(await rd.read(3), Buffer.from([1, 2, 3]));
});

test('rechaza una resolución VNC absurda sin reservar memoria', async (t) => {
  const port = await startSnapshotServer(t, { width: 65535, height: 65535 });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /Resolución VNC fuera de límites/);
});

test('rechaza un nombre de escritorio gigante', async (t) => {
  const port = await startSnapshotServer(t, { nameLength: 0xffffffff });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /Nombre de escritorio VNC demasiado largo/);
});

test('rechaza un ServerCutText gigante', async (t) => {
  const port = await startSnapshotServer(t, {
    afterInit: (sock) => {
      const b = Buffer.alloc(8);
      b[0] = 3;
      b.writeUInt32BE(0xffffffff, 4);
      sock.write(b);
    },
  });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /ServerCutText demasiado grande/);
});

test('rechaza un FramebufferUpdate con demasiados rectángulos', async (t) => {
  const port = await startSnapshotServer(t, {
    afterInit: (sock) => {
      const b = Buffer.alloc(4);
      b[0] = 0;
      b.writeUInt16BE(4097, 2);
      sock.write(b);
    },
  });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /demasiados rectángulos/);
});

test('rechaza un rectángulo fuera de la pantalla', async (t) => {
  const port = await startSnapshotServer(t, {
    afterInit: (sock) => {
      sock.write(framebufferUpdate([rectMsg({ x: 700, y: 0, w: 200, h: 100, enc: 0 })]));
    },
  });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /fuera de pantalla/);
});

test('rechaza un ZRLE que anuncia más de lo permitido', async (t) => {
  const port = await startSnapshotServer(t, {
    afterInit: (sock) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(32 * 1024 * 1024 + 1, 0);
      sock.write(Buffer.concat([framebufferUpdate([rectMsg({ w: 800, h: 600, enc: 16 })]), len]));
    },
  });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /Datos ZRLE demasiado grandes/);
});

test('rechaza una bomba de descompresión ZRLE', async (t) => {
  const port = await startSnapshotServer(t, {
    afterInit: (sock) => {
      // 4 MB de ceros comprimidos: el límite para 800x600 es ~3 MB descomprimidos.
      const compressed = zlib.deflateSync(Buffer.alloc(4 * 1024 * 1024));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(compressed.length, 0);
      sock.write(Buffer.concat([framebufferUpdate([rectMsg({ w: 800, h: 600, enc: 16 })]), len, compressed]));
    },
  });
  await assert.rejects(grabFrame('127.0.0.1', port, '', OPTS), /Cannot create a Buffer larger|ERR_BUFFER_TOO_LARGE/);
});

test('decodeZrle rechaza datos truncados', () => {
  const out = Buffer.alloc(3);
  assert.throws(
    () => decodeZrle(Buffer.from([]), 0, { x: 0, y: 0, w: 1, h: 1 }, out, 1),
    /Datos ZRLE truncados/,
  );
  assert.throws(
    () => decodeZrle(Buffer.from([0]), 0, { x: 0, y: 0, w: 1, h: 1 }, out, 1),
    /Datos ZRLE truncados \(raw\)/,
  );
});
