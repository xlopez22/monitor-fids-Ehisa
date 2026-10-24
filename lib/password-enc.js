// Cifrado en reposo de las contraseñas VNC propias de cada equipo.
//
// Formato guardado: enc:v1:<base64url(iv (12 bytes) || tag (16 bytes) || ciphertext)>
// La clave es DATA_ENCRYPTION_KEY (32 bytes en base64/base64url), independiente de la
// contraseña del panel y de SESSION_SECRET: cambiar el login no rompe el inventario.
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedRaw = null;
let cachedKey = null;

function decodeKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  // base64url y base64 comparten el alfabeto salvo +/ y el relleno; se aceptan ambos.
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalized, 'base64');
  return buf.length === KEY_BYTES ? buf : null;
}

function isValidDataEncryptionKey(raw) {
  return decodeKey(raw) !== null;
}

function getKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error(
      'Falta DATA_ENCRYPTION_KEY. Genera una con "npm run set-password" o agrega una clave de 32 bytes en .env.'
    );
  }
  if (raw === cachedRaw && cachedKey) return cachedKey;
  const key = decodeKey(raw);
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY no es válida: debe ser una clave de 32 bytes en base64/base64url.');
  }
  cachedRaw = raw;
  cachedKey = key;
  return key;
}

function generateDataEncryptionKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64url');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(text) {
  if (text === undefined || text === null || text === '') return text;
  if (isEncrypted(text)) return text; // ya cifrado: no volver a cifrar
  const value = String(text);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function decrypt(value) {
  if (value === undefined || value === null || value === '') return value;
  // Inventarios viejos: contraseña en texto plano. Se devuelve tal cual y Store la
  // vuelve a guardar cifrada en la primera carga.
  if (!isEncrypted(value)) return value;
  const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Contraseña cifrada con formato inválido en el inventario.');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error(
      `No se pudo descifrar una contraseña del inventario. ¿Cambió DATA_ENCRYPTION_KEY? (${e.message})`
    );
  }
}

module.exports = {
  PREFIX,
  isValidDataEncryptionKey,
  generateDataEncryptionKey,
  isEncrypted,
  encrypt,
  decrypt,
};
