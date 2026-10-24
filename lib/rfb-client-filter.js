// Filtro de los mensajes RFB que van del navegador (noVNC) al equipo VNC.
//
// RFB es un flujo de bytes: un mensaje puede llegar partido en varios frames WebSocket
// o varios mensajes pueden venir juntos. Por eso no alcanza con mirar el primer byte
// de cada frame: hay que acumular y reconocer mensajes completos.
//
// En solo lectura se reenvían únicamente los mensajes que no afectan al equipo:
//   SetPixelFormat (0), SetEncodings (2) y FramebufferUpdateRequest (3).
// Se descartan teclado (4), puntero (5), portapapeles (6) y las extensiones que
// cambian el escritorio remoto, el portapapeles o apagan el equipo (150, 248, 250, 251, 255).
const EMPTY = Buffer.alloc(0);
const MAX_BUFFER = 16 * 1024 * 1024 + 1024;
const MAX_CLIPBOARD = 16 * 1024 * 1024;
const MAX_ENCODINGS = 4096;
const MAX_SCREENS = 64;
const SAFE_TYPES = new Set([0, 2, 3]);

// Devuelve cuánto mide el mensaje que empieza en buf, o 0 si todavía falta la cabecera.
// Lanza error si el mensaje es imposible o supera los límites defensivos.
function messageLength(buf) {
  const type = buf[0];
  switch (type) {
    case 0: // SetPixelFormat
      return 20;
    case 2: { // SetEncodings
      if (buf.length < 4) return 0;
      const count = buf.readUInt16BE(2);
      if (count > MAX_ENCODINGS) throw new Error(`SetEncodings con ${count} codificaciones`);
      return 4 + 4 * count;
    }
    case 3: // FramebufferUpdateRequest
      return 10;
    case 4: // KeyEvent
      return 8;
    case 5: // PointerEvent (el bit 7 del botón indica la variante extendida)
      if (buf.length < 2) return 0;
      return (buf[1] & 0x80) ? 7 : 6;
    case 6: { // ClientCutText; longitud negativa = portapapeles extendido
      if (buf.length < 8) return 0;
      const len = buf.readInt32BE(4);
      const size = Math.abs(len);
      if (size > MAX_CLIPBOARD) throw new Error(`ClientCutText de ${size} bytes`);
      return 8 + size;
    }
    case 150: // EnableContinuousUpdates
      return 10;
    case 248: // ClientFence
      if (buf.length < 9) return 0;
      return 9 + buf[8];
    case 250: // XVP (apagar/reiniciar el servidor VNC)
      return 4;
    case 251: { // SetDesktopSize
      if (buf.length < 8) return 0;
      const screens = buf[6];
      if (screens > MAX_SCREENS) throw new Error(`SetDesktopSize con ${screens} pantallas`);
      return 8 + 16 * screens;
    }
    case 255: // QEMU Extended Key Event (sub-tipo 0)
      if (buf.length >= 2 && buf[1] !== 0) throw new Error(`QEMU Extended Key Event con sub-tipo ${buf[1]}`);
      return 12;
    default:
      throw new Error(`Mensaje RFB de cliente no soportado: tipo ${type}`);
  }
}

function createClientFilter() {
  let buf = EMPTY;
  const blocked = { key: 0, pointer: 0, clipboard: 0, other: 0 };

  // readOnly se evalúa al completar cada mensaje. Devuelve los bytes que deben
  // reenviarse al VNC (posiblemente vacío).
  function push(data, readOnly = true) {
    if (data && data.length) {
      buf = buf.length ? Buffer.concat([buf, data]) : data;
      if (buf.length > MAX_BUFFER) throw new Error('Búfer RFB del cliente demasiado grande');
    }

    const out = [];
    while (buf.length) {
      const need = messageLength(buf);
      if (!need || buf.length < need) break;
      const msg = buf.subarray(0, need);
      buf = buf.subarray(need);

      if (!readOnly || SAFE_TYPES.has(msg[0])) {
        out.push(msg);
        continue;
      }
      if (msg[0] === 4 || msg[0] === 255) blocked.key++;
      else if (msg[0] === 5) blocked.pointer++;
      else if (msg[0] === 6) blocked.clipboard++;
      else blocked.other++;
    }

    if (out.length === 0) return EMPTY;
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  return {
    push,
    blocked,
    pending: () => buf.length,
  };
}

module.exports = { createClientFilter, SAFE_TYPES };
