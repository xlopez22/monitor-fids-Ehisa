// Genera la contraseña del panel y la guarda hasheada en .env.
// Uso: npm run set-password
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword, generateSessionSecret } = require('../lib/password');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const AUTH_COMMENT = '# Login del panel (generado por npm run set-password)';

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

function updateEnv(passwordHash, sessionSecret, envPath = ENV_PATH) {
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const lines = text.split(/\r?\n/).filter((line) =>
    !/^\s*AUTH_PASSWORD_HASH\s*=/.test(line)
    && !/^\s*SESSION_SECRET\s*=/.test(line)
    && !line.startsWith(AUTH_COMMENT));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const out = [
    ...lines,
    ...(lines.length ? [''] : []),
    AUTH_COMMENT,
    `AUTH_PASSWORD_HASH=${passwordHash}`,
    `SESSION_SECRET=${sessionSecret}`,
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

  updateEnv(hashPassword(password), generateSessionSecret());
  console.log(`Listo. Guardado en ${ENV_PATH}. Reinicia el servidor para aplicar el cambio.`);
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
