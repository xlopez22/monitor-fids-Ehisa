// Cabeceras de seguridad para todas las respuestas del panel.
// La CSP no permite scripts inline: el JS del visor vive en public/view.js.
function wsOrigins(origins = []) {
  const out = new Set();
  for (const origin of origins) {
    try {
      const u = new URL(origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      out.add(u.origin);
    } catch {
      // Un origen mal configurado se ignora; el servidor igual valida Host/Origin.
    }
  }
  return [...out];
}

function buildCsp(origins = []) {
  const connect = ["'self'", ...wsOrigins(origins)];
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "media-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

function securityHeaders({ origins = [] } = {}) {
  const csp = buildCsp(origins);
  return (req, res, next) => {
    res.set('Content-Security-Policy', csp);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

module.exports = { buildCsp, securityHeaders, wsOrigins };
