// Genera la contraseña del panel y la guarda hasheada en .env.
// Uso: npm run set-password
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword, generateSessionSecret } = require('../lib/password');
const { generateDataEncryptionKey, isValidDataEncryptionKey } = require('../lib/password-enc');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const AUTH_COMMENT = '# Login del panel (generado por npm run set-password)';
const DATA_COMMENT = '# Clave de cifrado de contraseñas VNC (no cambiar: el inventario quedaría ilegible)';

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error('Este comando necesita una terminal interactiva.'));
    }
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';
    let finished = false;

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          const err = new Error('Cancelado');
          err.code = 'CANCEL';
          return finish(err);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          stdout.write('*');
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

function readEnvValue(name, envPath = ENV_PATH) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm').exec(text);
    return m ? m[1].trim() : '';
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function updateEnv(passwordHash, sessionSecret, dataKey, envPath = ENV_PATH) {
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const lines = text.split(/\r?\n/).filter((line) =>
    !/^\s*AUTH_PASSWORD_HASH\s*=/.test(line)
    && !/^\s*SESSION_SECRET\s*=/.test(line)
    && !/^\s*DATA_ENCRYPTION_KEY\s*=/.test(line)
    && !line.startsWith(AUTH_COMMENT)
    && !line.startsWith(DATA_COMMENT));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const out = [
    ...lines,
    ...(lines.length ? [''] : []),
    AUTH_COMMENT,
    `AUTH_PASSWORD_HASH=${passwordHash}`,
    `SESSION_SECRET=${sessionSecret}`,
    '',
    DATA_COMMENT,
    `DATA_ENCRYPTION_KEY=${dataKey}`,
    '',
  ].join(os.EOL);

  fs.writeFileSync(envPath, out, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* Windows no usa estos permisos */ }
}

async function main() {
  console.log('Configuración del acceso al panel FIDS Monitor.');
  console.log('La contraseña no se guarda en texto plano; solo su hash scrypt.');
  const password = await askHidden('Nueva contraseña (mínimo 12 caracteres): ');
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres.');
  if (password.length > 1024) throw new Error('La contraseña es demasiado larga.');
  const repeat = await askHidden('Repite la contraseña: ');
  if (password !== repeat) throw new Error('Las contraseñas no coinciden.');

  // La clave de cifrado del inventario no se rota al cambiar el login: si existía, se
  // conserva (rotarla dejaría ilegibles las contraseñas VNC ya guardadas).
  const existingKey = readEnvValue('DATA_ENCRYPTION_KEY');
  if (existingKey && !isValidDataEncryptionKey(existingKey)) {
    throw new Error(
      'La DATA_ENCRYPTION_KEY actual en .env no es válida (deben ser 32 bytes en base64). '
      + 'Corrígela a mano en lugar de regenerarla: si el inventario ya tiene contraseñas cifradas, se perderían.'
    );
  }
  const dataKey = existingKey || generateDataEncryptionKey();

  updateEnv(hashPassword(password), generateSessionSecret(), dataKey);
  console.log(`Listo. Guardado en ${ENV_PATH}. Reinicia el servidor para aplicar el cambio.`);
  console.log(existingKey
    ? 'Se conservó la DATA_ENCRYPTION_KEY existente.'
    : 'Se generó una DATA_ENCRYPTION_KEY nueva para cifrar las contraseñas VNC.');
}

if (require.main === module) {
  main().catch((e) => {
    if (e.code === 'CANCEL') {
      console.error('\nCancelado.');
      process.exit(130);
    }
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { updateEnv };
