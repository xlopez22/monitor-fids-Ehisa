// Conexión al VNC por TCP plano o TLS.
//
// El protocolo RFB (VNC) clásico no cifra la sesión. Si delante de cada equipo hay
// un stunnel/gateway TLS, el flujo RFB sigue siendo el mismo pero viaja cifrado y el
// certificado permite detectar un equipo falso (MITM).
const fs = require('fs');
const net = require('net');
const tls = require('tls');

function loadCa(file) {
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`No se pudo leer VNC_TLS_CA (${file}): ${e.message}`);
  }
}

// Devuelve el socket y el evento que indica que ya se puede hablar RFB:
// 'connect' para TCP plano, 'secureConnect' cuando el handshake TLS terminó.
function createVncSocket({ host, port, useTls = false, ca, rejectUnauthorized = true, servername }) {
  if (!useTls) {
    return { sock: net.connect({ host, port }), readyEvent: 'connect' };
  }
  const opts = { host, port, rejectUnauthorized };
  if (ca) opts.ca = ca;
  if (servername) opts.servername = servername;
  return { sock: tls.connect(opts), readyEvent: 'secureConnect' };
}

module.exports = { loadCa, createVncSocket };
