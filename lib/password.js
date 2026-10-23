// Hash y verificación de la contraseña local del panel.
// No depende de Express ni de la base de datos: solo crypto.
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  // Sin '$' para que Docker Compose no interprete el valor como variable.
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${key.toString('hex')}`;
}

function parseStored(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N <= 0 || r <= 0 || p <= 0) return null;
  if (!/^[0-9a-f]{32}$/i.test(parts[4]) || !/^[0-9a-f]{64}$/i.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'hex');
  const hash = Buffer.from(parts[5], 'hex');
  return { N, r, p, salt, hash, keylen: hash.length };
}

function isValidPasswordHash(stored) {
  return Boolean(parseStored(stored));
}

function verifyPassword(password, stored) {
  const parsed = parseStored(stored);
  if (!parsed || typeof password !== 'string' || password.length > 1024) return false;
  const key = crypto.scryptSync(password, parsed.salt, parsed.keylen, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT.maxmem,
  });
  return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  SCRYPT,
  hashPassword,
  verifyPassword,
  isValidPasswordHash,
  generateSessionSecret,
};
