require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Monitor, toJpeg, friendly, dominantColor, HEALTH } = require('./lib/snapshot');
const { grabFrame } = require('./lib/rfb-snapshot');
const { bridge } = require('./lib/vnc-proxy');
const { Store } = require('./lib/store');
const { parseWorkbook, GROUPS } = require('./lib/excel');
const { scanSubnet } = require('./lib/scan');
const { createAuth } = require('./lib/auth');
const { isValidDataEncryptionKey } = require('./lib/password-enc');

const port = Number(process.env.PORT) || 8080;
const cfg = {
  host: process.env.HOST || '127.0.0.1',
  port,
  vncPort: Number(process.env.VNC_PORT) || 5900,
  vncPassword: process.env.VNC_PASSWORD || '',
  roundSeconds: Number(process.env.ROUND_SECONDS) || 90,
  concurrency: Number(process.env.CONCURRENCY) || 6,
  // Lo que teclea el botón "Reiniciar NG-Client" en Ejecutar (Win+R) del equipo remoto, en dos pasos.
  // Sin '&' ni comillas, en minúsculas: menos teclas especiales que traducir por VNC.
  ngClientKill: process.env.NG_CLIENT_KILL || 'taskkill /f /im ng-client.exe',
  ngClientStart: process.env.NG_CLIENT_START || 'c:\\dds\\ng-client\\ng-client.exe --fids-allow-invalid-cert',
  inventory: process.env.INVENTORY_FILE || path.join(__dirname, 'data', 'inventory.json'),
  authHash: process.env.AUTH_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || ''),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  // Hosts/orígenes que el navegador puede usar. En local son 127.0.0.1 y localhost.
  // Si se abre por la LAN o detrás de un proxy, hay que agregarlos en .env.
  appHosts: (process.env.APP_HOSTS || `127.0.0.1:${port},localhost:${port}`)
    .split(',').map((s) => s.trim()).filter(Boolean),
  appOrigins: (process.env.APP_ORIGINS || `http://127.0.0.1:${port},http://localhost:${port}`)
    .split(',').map((s) => s.trim()).filter(Boolean),
};

let auth;
try {
  auth = createAuth({
    passwordHash: cfg.authHash,
    sessionSecret: cfg.sessionSecret,
    hosts: cfg.appHosts,
    origins: cfg.appOrigins,
    secureCookie: cfg.cookieSecure,
  });
} catch (e) {
  console.error(`No se puede iniciar el login: ${e.message}`);
  console.error('Configura el acceso con: npm run set-password');
  process.exit(1);
}

// La autenticación VNC usa DES, que Node 17+ solo trae con el proveedor "legacy" de OpenSSL
try {
  crypto.createCipheriv('des-ecb', Buffer.alloc(8), null);
} catch {
  console.error('DES no disponible. Inicia con "npm start" (usa --openssl-legacy-provider).');
  process.exit(1);
}
if (!cfg.vncPassword) console.warn('Aviso: VNC_PASSWORD vacío; solo funcionarán equipos con contraseña propia o sin contraseña.');

// Las contraseñas VNC por equipo se guardan cifradas en el inventario. Sin esta clave el
// servidor no puede leerlas ni volver a guardarlas, así que se exige al arrancar.
if (!isValidDataEncryptionKey(process.env.DATA_ENCRYPTION_KEY)) {
  console.error('Falta DATA_ENCRYPTION_KEY o no es válida (32 bytes en base64/base64url).');
  console.error('Genera una con: npm run set-password');
  process.exit(1);
}

let store;
try {
  store = new Store(cfg.inventory);
} catch (e) {
  console.error(`No se pudo cargar el inventario (${cfg.inventory}): ${e.message}`);
  process.exit(1);
}
if (!store.devices.length) console.warn(`Inventario vacío (${cfg.inventory}). Usa "Importar Excel" o "Agregar equipo" en el tablero.`);

// Monitor y tienda comparten el mismo arreglo: lo que se agrega/borra entra en la siguiente ronda
const monitor = new Monitor(store.devices, {
  port: cfg.vncPort,
  password: cfg.vncPassword,
  intervalMs: cfg.roundSeconds * 1000,
  concurrency: cfg.concurrency,
});
const loadDesktopRefs = () => {
  monitor.desktopColors = [...HEALTH.defaultDesktopColors, ...store.settings.desktopRefs.map((r) => r.color).filter(Boolean)];
};
loadDesktopRefs();
const proxyErrors = {}; // ip -> último error del visor en vivo

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', cfg.trustProxy ? 1 : false);
app.use(express.json());
app.use(auth.sessionParser);
app.use(auth.originGuard);

// Rutas públicas del login. El resto del panel queda detrás de requireAuth.
app.post('/api/login', auth.loginLimiter, auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/session', auth.sessionInfo);

// Token CSRF para mutaciones (se renueva en login)
app.get('/api/csrf-token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ token: req.session.csrf });
});

// Token de un solo uso para WebSocket (se pide desde view.html antes de conectar)
app.get('/api/ws-token', auth.issueWsToken);

app.use(auth.requireAuth);
app.use(auth.csrfGuard);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/novnc', express.static(path.join(__dirname, 'node_modules', '@novnc', 'novnc')));

const view = (d) => ({
  ...Store.public(d),
  status: monitor.status[d.ip] || null,
  thumbAt: monitor.thumbs[d.ip]?.takenAt || null,
  resolution: monitor.thumbs[d.ip] ? `${monitor.thumbs[d.ip].width}x${monitor.thumbs[d.ip].height}` : null,
  thumbError: monitor.errors[d.ip]?.message || null,
  health: monitor.health(d),
});

// Firma actual de un equipo, o error si todavía no hay captura
function currentSig(ip) {
  if (!store.get(ip)) throw new Error('IP fuera del inventario');
  const s = monitor.sigs[ip];
  if (!s) throw new Error('Este equipo aún no tiene captura; usa ↻ y vuelve a intentar');
  return s.sig;
}

// Envuelve handlers async para responder errores como JSON
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

app.get('/api/devices', (req, res) => {
  res.json({
    roundSeconds: cfg.roundSeconds,
    roundRunning: monitor.running,
    groups: GROUPS,
    desktopRefs: store.settings.desktopRefs.map(({ from, at, color }) => ({ from, at, color })),
    devices: store.devices.map(view),
  });
});

app.get('/api/config', (req, res) => {
  res.json({ ngClientKill: cfg.ngClientKill, ngClientStart: cfg.ngClientStart });
});

// "Así se ve normal": guarda la pantalla actual como referencia del equipo
app.post('/api/devices/:ip/baseline', h(async (req, res) => {
  store.setBaseline(req.params.ip, currentSig(req.params.ip).toString('base64'));
  res.json(view(store.get(req.params.ip)));
}));
app.delete('/api/devices/:ip/baseline', h(async (req, res) => {
  store.setBaseline(req.params.ip, null);
  res.json(view(store.get(req.params.ip)));
}));

// "Esto es el escritorio de Windows": referencia global para detectar NG-Client no visible
app.post('/api/desktop-refs', h(async (req, res) => {
  const color = dominantColor(currentSig(req.body.ip));
  store.addDesktopRef(req.body.ip, color);
  loadDesktopRefs();
  res.status(201).json({ color, count: store.settings.desktopRefs.length });
}));
app.delete('/api/desktop-refs', h(async (req, res) => {
  store.clearDesktopRefs();
  loadDesktopRefs();
  res.status(204).end();
}));

app.post('/api/devices', h(async (req, res) => {
  const d = store.add(req.body);
  monitor.capture(d.ip); // primera captura sin esperar la ronda
  res.status(201).json(view(d));
}));

app.put('/api/devices/:ip', h(async (req, res) => {
  const d = store.update(req.params.ip, req.body);
  if (d.ip !== req.params.ip) monitor.forget(req.params.ip);
  await monitor.capture(d.ip); // por si cambió la contraseña o la IP
  res.json(view(d));
}));

app.delete('/api/devices/:ip', h(async (req, res) => {
  store.remove(req.params.ip);
  monitor.forget(req.params.ip);
  res.status(204).end();
}));

// Vuelve a sacar la miniatura de un equipo
app.post('/api/devices/:ip/refresh', h(async (req, res) => {
  if (!store.get(req.params.ip)) throw new Error('IP fuera del inventario');
  await monitor.capture(req.params.ip);
  res.json(view(store.get(req.params.ip)));
}));

// Lanza una ronda completa ya (no espera a que termine)
app.post('/api/refresh-all', (req, res) => {
  monitor.runOnce();
  res.status(202).json({ running: true });
});

app.get('/api/devices/:ip/proxy-error', (req, res) => {
  res.json({ error: proxyErrors[req.params.ip] || null });
});

// Busca equipos con VNC abierto que no estén en el inventario y prueba la contraseña general
app.post('/api/scan', h(async (req, res) => {
  const known = new Set(store.devices.map((d) => d.ip));
  const prefixes = req.body.prefix
    ? [String(req.body.prefix).trim()]
    : [...new Set(store.devices.map((d) => d.ip.split('.').slice(0, 3).join('.')))];
  if (!prefixes.length) throw new Error('Indica la red a revisar, por ejemplo 192.168.10');
  const found = [];
  for (const p of prefixes) found.push(...await scanSubnet(p, { port: cfg.vncPort, skip: known }));

  const results = [];
  const queue = [...found];
  const worker = async () => {
    while (queue.length) {
      const ip = queue.shift();
      try {
        const f = await grabFrame(ip, cfg.vncPort, cfg.vncPassword);
        const jpeg = await toJpeg(f, 320);
        results.push({ ip, ok: true, resolution: `${f.width}x${f.height}`, thumb: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
      } catch (e) {
        results.push({ ip, ok: false, error: friendly(e.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  results.sort((a, b) => Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3]));
  res.json({ prefixes, results });
}));

// Importa el Excel de inventario subido desde el tablero
app.post('/api/import', express.raw({ type: '*/*', limit: '20mb' }), h(async (req, res) => {
  if (!req.body?.length) throw new Error('Archivo vacío');
  const r = store.merge(await parseWorkbook(req.body));
  monitor.runOnce();
  res.json({ ...r, total: store.devices.length });
}));

app.get('/thumb/:ip', (req, res) => {
  const t = monitor.thumbs[req.params.ip];
  if (!t) return res.status(404).end();
  // El tablero pide /thumb/<ip>?t=<hora de captura>, así que cada URL es inmutable
  res.set('Cache-Control', 'private, max-age=3600').type('jpeg').send(t.jpeg);
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
});

server.on('upgrade', (req, socket, head) => {
  // El upgrade no pasa por Express: se validan Host/Origin, la sesión y el token WS de un solo uso.
  if (!auth.isAllowedHost(req.headers.host) || !auth.isAllowedOrigin(req.headers.origin)) {
    return socket.destroy();
  }
  auth.loadSession(req).then((session) => {
    if (!session?.authenticated) return socket.destroy();
    // Validar token WS de un solo uso (?t=...)
    return auth.consumeWsToken(req).then((ok) => {
      if (!ok) return socket.destroy();
      // req.url incluye query string; extraer solo la ruta
      const urlPath = req.url.split('?')[0];
      const m = /^\/ws\/([\d.]+)$/.exec(urlPath);
      const d = m && store.get(m[1]);
      // Solo se permite conectar a equipos del inventario: no es un proxy abierto
      if (!d) return socket.destroy();
      delete proxyErrors[d.ip];
      wss.handleUpgrade(req, socket, head, (ws) => {
        bridge(ws, {
          host: d.ip,
          port: d.port || cfg.vncPort,
          password: d.password || cfg.vncPassword,
          onError: (why) => { proxyErrors[d.ip] = friendly(why); },
        });
      });
    });
  }).catch(() => socket.destroy());
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`FIDS Monitor: http://${cfg.host}:${cfg.port}  (${store.devices.length} equipos)`);
  monitor.start();
});
