const fs = require('fs');
const WebSocket = require('ws');

const jar = fs.readFileSync('C:/Users/xavier.lopez/AppData/Local/Temp/opencode/fids-csrf-test.txt', 'utf8');
let cookie = '';
const lines = jar.split(/\r?\n/);
for (const line of lines) {
  if (line.startsWith('#HttpOnly_') || (!line.startsWith('#') && line.includes('fids.sid'))) {
    const fields = line.split('\t');
    if (fields.length >= 7 && (fields[5] === 'fids.sid' || fields[5].includes('fids.sid'))) {
      cookie = `fids.sid=${fields[6]}`;
      break;
    }
  }
}
if (!cookie) {
  // fallback: buscar cualquier línea con fids.sid
  for (const line of lines) {
    if (!line.startsWith('#') && line.includes('fids.sid')) {
      const fields = line.split('\t');
      if (fields.length >= 7) {
        cookie = `fids.sid=${fields[6]}`;
        break;
      }
    }
  }
}
console.log('Cookie:', cookie);

function getCsrf(jar) {
  const line = jar.split(/\r?\n/).find((l) => l.includes('fids.csrf'));
  if (!line) return null;
  const fields = line.split('\t');
  return fields[6];
}

async function getWsToken() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get('http://127.0.0.1:18083/api/ws-token', { headers: { Cookie: cookie } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('ws-token response:', res.statusCode, data);
        try { resolve(JSON.parse(data).token); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.log('ws-token error:', e.message); resolve(null); });
    req.end();
  });
}

function tryWs(label, url, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) {
        ws.terminate();
        console.log(`${label}: TIMEOUT`);
        resolve();
      }
    }, 4000);
    ws.on('open', () => {
      opened = true;
      clearTimeout(timer);
      console.log(`${label}: OPEN (101)`);
      ws.close();
      resolve();
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      console.log(`${label}: HTTP ${res.statusCode}`);
      resolve();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      console.log(`${label}: ERROR (${err.message})`);
      resolve();
    });
    ws.on('close', (code) => {
      if (!opened) {
        clearTimeout(timer);
        console.log(`${label}: CLOSE (${code})`);
        resolve();
      }
    });
  });
}

(async () => {
  const token = await getWsToken();
  console.log('WS Token:', token);
  
  // Con token válido
  await tryWs('con token válido', `ws://127.0.0.1:18083/ws/127.0.0.2?t=${token}`, {
    origin: 'http://127.0.0.1:18083',
    headers: { Cookie: cookie },
  });
  
  // Reutilizar el mismo token (debería fallar - token de un solo uso)
  await tryWs('reutilizando token', `ws://127.0.0.1:18083/ws/127.0.0.2?t=${token}`, {
    origin: 'http://127.0.0.1:18083',
    headers: { Cookie: cookie },
  });
  
  // Sin token
  await tryWs('sin token', `ws://127.0.0.1:18083/ws/127.0.0.2`, {
    origin: 'http://127.0.0.1:18083',
    headers: { Cookie: cookie },
  });
  
  // Token inválido
  await tryWs('token inválido', `ws://127.0.0.1:18083/ws/127.0.0.2?t=invalido`, {
    origin: 'http://127.0.0.1:18083',
    headers: { Cookie: cookie },
  });
})();