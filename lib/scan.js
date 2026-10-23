// Busca equipos con el puerto VNC abierto en una red /24.
// Es un barrido manual (botón "Buscar equipos nuevos"): un solo intento TCP por IP,
// para no acercarse al bloqueo de UltraVNC por intentos repetidos.
const net = require('net');

function isOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// prefix = "192.168.10" -> revisa .1 a .254
async function scanSubnet(prefix, { port = 5900, timeoutMs = 800, concurrency = 64, skip = new Set() } = {}) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) throw new Error('Red no válida, usa el formato 192.168.10');
  const queue = [];
  for (let i = 1; i <= 254; i++) if (!skip.has(`${prefix}.${i}`)) queue.push(`${prefix}.${i}`);
  const found = [];
  const worker = async () => {
    while (queue.length) {
      const ip = queue.shift();
      if (await isOpen(ip, port, timeoutMs)) found.push(ip);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
}

module.exports = { scanSubnet };
