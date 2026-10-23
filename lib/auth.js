// Autenticación mínima para una instalación local: una sola contraseña,
// sesión con cookie y sin roles. La contraseña se guarda hasheada con scrypt.
const crypto = require('crypto');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { verifyPassword, isValidPasswordHash } = require('./password');

const COOKIE_NAME = 'fids.sid';
const CSRF_COOKIE_NAME = 'fids.csrf';
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico', '/api/csrf-token', '/api/ws-token']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

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

  function generateToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  function issueCsrfToken(req, res) {
    const token = generateToken();
    req.session.csrf = token;
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // legible por JS para enviar en header
      sameSite: 'strict',
      secure: secureCookie,
      maxAge: sessionMaxAge,
      path: '/',
    });
    return token;
  }

  function csrfGuard(req, res, next) {
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (req.path === '/api/login' || req.path === '/api/logout') return next(); // login/logout tienen rate limit y origin guard
    const token = req.headers['x-csrf-token'] || req.body?._csrf || req.query._csrf;
    const sessionToken = req.session?.csrf;
    if (!token || !sessionToken || token !== sessionToken) {
      return deny(req, res, 403, 'Token CSRF inválido');
    }
    next();
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
      issueCsrfToken(req, res);
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

  // Token de un solo uso para WebSocket (se genera en view.html y se valida en upgrade)
  function issueWsToken(req, res) {
    const token = generateToken();
    req.session.wsToken = token;
    res.set('Cache-Control', 'no-store');
    res.json({ token });
  }

  function consumeWsToken(req) {
    // En el upgrade de WebSocket, req es http.IncomingMessage y no tiene req.query
    // Parsear manualmente la query string de req.url
    const url = req.url || '';
    const queryStart = url.indexOf('?');
    const queryString = queryStart >= 0 ? url.substring(queryStart + 1) : '';
    const params = new URLSearchParams(queryString);
    const token = params.get('t');
    const sessionToken = req.session?.wsToken;
    if (!token || !sessionToken || token !== sessionToken) return false;
    // Consumir: invalidar para que no se reutilice
    delete req.session.wsToken;
    // Guardar la sesión para que el cambio persista
    return new Promise((resolve) => {
      req.session.save((err) => {
        if (err) {
          console.warn('[auth] Error guardando sesión tras consumir WS token:', err.message);
        }
        resolve(true);
      });
    });
  }

  return {
    sessionParser,
    loginLimiter,
    originGuard,
    requireAuth,
    csrfGuard,
    sessionInfo,
    login,
    logout,
    loadSession,
    issueWsToken,
    consumeWsToken,
    isAllowedHost,
    isAllowedOrigin,
  };
}

module.exports = { createAuth, COOKIE_NAME, CSRF_COOKIE_NAME, PUBLIC_PATHS, MUTATING_METHODS };
