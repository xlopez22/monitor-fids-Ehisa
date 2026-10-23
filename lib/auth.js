// Autenticación mínima para una instalación local: una sola contraseña,
// sesión con cookie y sin roles. La contraseña se guarda hasheada con scrypt.
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { verifyPassword, isValidPasswordHash } = require('./password');

const COOKIE_NAME = 'fids.sid';
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico']);

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().toLowerCase().replace(/\/+$/, '');
}

function createAuth({
  passwordHash,
  sessionSecret,
  hosts,
  origins,
  secureCookie = false,
  sessionMaxAge = 12 * 60 * 60 * 1000,
}) {
  if (!isValidPasswordHash(passwordHash)) {
    throw new Error('AUTH_PASSWORD_HASH falta o no tiene un formato válido (scrypt:...)');
  }
  if (!sessionSecret || String(sessionSecret).length < 32) {
    throw new Error('SESSION_SECRET falta o es demasiado corto (mínimo 32 caracteres)');
  }
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('APP_HOSTS está vacío');
  if (!Array.isArray(origins) || !origins.length) throw new Error('APP_ORIGINS está vacío');

  const allowedHosts = new Set(hosts.map(normalizeHost));
  const allowedOrigins = new Set(origins.map(normalizeOrigin));

  function isAllowedHost(host) {
    return Boolean(host) && allowedHosts.has(normalizeHost(host));
  }

  // Las peticiones sin Origin (curl, peticiones same-origin GET) se permiten;
  // si el navegador manda Origin, tiene que estar en la lista.
  function isAllowedOrigin(origin) {
    return !origin || allowedOrigins.has(normalizeOrigin(origin));
  }

  const sessionParser = session({
    name: COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      maxAge: sessionMaxAge,
    },
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => res.status(429).json({
      error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
    }),
  });

  function deny(req, res, status, message) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/thumb/') || req.path.startsWith('/novnc/')) {
      return res.status(status).json({ error: message });
    }
    return res.status(status).type('text').send(message);
  }

  function originGuard(req, res, next) {
    if (!isAllowedHost(req.headers.host)) return deny(req, res, 403, 'Host no permitido');
    if (!isAllowedOrigin(req.headers.origin)) return deny(req, res, 403, 'Origen no permitido');
    // Un POST cross-site de un navegador moderno se corta aquí aunque no mande Origin.
    if (req.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return deny(req, res, 403, 'Petición cross-site bloqueada');
    }
    next();
  }

  function requireAuth(req, res, next) {
    if (req.session?.authenticated || PUBLIC_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/thumb/') || req.path.startsWith('/novnc/')) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/login.html');
  }

  function sessionInfo(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ authenticated: Boolean(req.session?.authenticated) });
  }

  function login(req, res, next) {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyPassword(password, passwordHash)) {
      console.warn(`[auth] login fallido desde ${req.ip}`);
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.status(204).end();
      });
    });
  }

  function logout(req, res, next) {
    if (!req.session) return res.status(204).end();
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(COOKIE_NAME);
      res.status(204).end();
    });
  }

  // Express-session no está pensado para el upgrade de WebSocket: se le pasa
  // un response mínimo para cargar la sesión y comprobar el login.
  function loadSession(req) {
    return new Promise((resolve, reject) => {
      const mockRes = {
        getHeader() {},
        setHeader() {},
        writeHead() {},
        write() { return true; },
        end() {},
      };
      sessionParser(req, mockRes, (err) => {
        if (err) return reject(err);
        resolve(req.session || null);
      });
    });
  }

  return {
    sessionParser,
    loginLimiter,
    originGuard,
    requireAuth,
    sessionInfo,
    login,
    logout,
    loadSession,
    isAllowedHost,
    isAllowedOrigin,
  };
}

module.exports = { createAuth, COOKIE_NAME, PUBLIC_PATHS };
