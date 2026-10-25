// Límites de uso por IP. El login ya tiene su propio límite en lib/auth.js.
// Las rutas caras (escaneo, importación, refrescos) tienen límites más estrictos
// que la API general para que un error o un script no sature la red ni el equipo.
const rateLimit = require('express-rate-limit');

const DEFAULT_MESSAGE = 'Demasiadas solicitudes. Espera un momento y vuelve a probar.';

function jsonLimiter({ windowMs, limit, message = DEFAULT_MESSAGE }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

// Ventana fija en memoria para el upgrade de WebSocket, que no pasa por Express.
class FixedWindowLimiter {
  constructor({ windowMs, limit, maxKeys = 10000 }) {
    if (!(windowMs > 0) || !(limit > 0)) throw new Error('Límite inválido');
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  take(key, now = Date.now()) {
    const k = String(key);
    if (this.entries.size > this.maxKeys) this.prune(now);
    let e = this.entries.get(k);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(k, e);
    }
    e.count += 1;
    const allowed = e.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - e.count),
      retryAfterMs: allowed ? 0 : Math.max(0, e.resetAt - now),
    };
  }

  prune(now) {
    for (const [k, e] of this.entries) {
      if (now >= e.resetAt) this.entries.delete(k);
    }
    while (this.entries.size > this.maxKeys) {
      const first = this.entries.keys().next().value;
      this.entries.delete(first);
    }
  }

  reset() {
    this.entries.clear();
  }
}

const LIMITS = Object.freeze({
  publicApi: { windowMs: 60_000, limit: 300, message: DEFAULT_MESSAGE },
  api: { windowMs: 60_000, limit: 300, message: DEFAULT_MESSAGE },
  scan: { windowMs: 10 * 60_000, limit: 5, message: 'Demasiadas búsquedas seguidas. Espera unos minutos.' },
  import: { windowMs: 10 * 60_000, limit: 5, message: 'Demasiadas importaciones seguidas. Espera unos minutos.' },
  refresh: { windowMs: 60_000, limit: 30, message: 'Demasiados refrescos seguidos. Espera un momento.' },
  refreshAll: { windowMs: 60_000, limit: 2, message: 'La ronda ya se está ejecutando; espera un minuto.' },
  control: { windowMs: 60_000, limit: 60, message: 'Demasiados cambios de control. Espera un momento.' },
  mutation: { windowMs: 60_000, limit: 60, message: 'Demasiados cambios seguidos. Espera un momento.' },
  ws: { windowMs: 60_000, limit: 30 },
});

function createLimiters() {
  return {
    publicApi: jsonLimiter(LIMITS.publicApi),
    api: jsonLimiter(LIMITS.api),
    scan: jsonLimiter(LIMITS.scan),
    import: jsonLimiter(LIMITS.import),
    refresh: jsonLimiter(LIMITS.refresh),
    refreshAll: jsonLimiter(LIMITS.refreshAll),
    control: jsonLimiter(LIMITS.control),
    mutation: jsonLimiter(LIMITS.mutation),
    ws: new FixedWindowLimiter(LIMITS.ws),
  };
}

module.exports = { jsonLimiter, FixedWindowLimiter, createLimiters, LIMITS };
