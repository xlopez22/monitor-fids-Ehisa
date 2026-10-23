// Ronda periódica sobre todos los equipos: UNA sesión VNC completa por equipo y ronda.
// Esa misma sesión da el estado (¿abrió el puerto?) y la miniatura.
// No se hacen sondeos TCP sueltos: UltraVNC cuenta las conexiones que se cierran sin
// autenticar como intentos fallidos y termina bloqueando temporalmente la IP de esta PC.
const sharp = require('sharp');
const { grabFrame } = require('./rfb-snapshot');

async function toJpeg({ rgb, width, height }, thumbWidth) {
  // "inside" para que las pantallas verticales (2160x3840) no queden gigantes
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize({ width: thumbWidth, height: thumbWidth, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}

// Firma de la pantalla: reducida a 64x36 RGB (6912 bytes). Sirve para comparar pantallas
// sin importar la resolución (4K, 1080p, vertical) y es barata de guardar.
const SIG_W = 64, SIG_H = 36;
async function signature({ rgb, width, height }) {
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(SIG_W, SIG_H, { fit: 'fill' })
    .raw()
    .toBuffer();
}

// Diferencia media por canal (0 = idénticas, 255 = opuestas)
function sigDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function luminance(sig) {
  const n = sig.length / 3;
  let sum = 0, sq = 0;
  for (let i = 0; i < sig.length; i += 3) {
    const l = 0.299 * sig[i] + 0.587 * sig[i + 1] + 0.114 * sig[i + 2];
    sum += l;
    sq += l * l;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

// ¿Cambió algo entre dos capturas? Basta un bloque de la firma que se mueva (p. ej. el reloj)
function changed(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 6) return true;
  return false;
}

// Color más frecuente de la firma (cuantizado a 8 niveles por canal)
function dominantColor(sig) {
  const counts = new Map();
  for (let i = 0; i < sig.length; i += 3) {
    const k = ((sig[i] >> 3) << 10) | ((sig[i + 1] >> 3) << 5) | (sig[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const [k] = [...counts].sort((x, y) => y[1] - x[1])[0];
  return [((k >> 10) << 3) + 4, (((k >> 5) & 31) << 3) + 4, ((k & 31) << 3) + 4];
}

// Fracción de la pantalla con un color dado (tolerancia por canal)
function colorFraction(sig, [r, g, b], tol = 10) {
  let n = 0;
  for (let i = 0; i < sig.length; i += 3) {
    if (Math.abs(sig[i] - r) <= tol && Math.abs(sig[i + 1] - g) <= tol && Math.abs(sig[i + 2] - b) <= tol) n++;
  }
  return n / (sig.length / 3);
}

// Umbrales calibrados con los equipos reales (22/10/2026):
// - Escritorio de Windows (SAP-OPSC-04): 97 % de la pantalla con su azul de fondo; tableros de vuelos,
//   logos de aerolíneas y pantallas EHISA: 3 % o menos. Se marca a partir de 30 % (aguanta la consola encima).
// - Fondo por defecto de Windows en estos equipos: RGB 4,100,180.
const HEALTH = {
  desktopFraction: 0.30,
  defaultDesktopColors: [[4, 100, 180]],
  baselineDiff: Number(process.env.BASELINE_DIFF) || 35,  // más que esto = distinta a su referencia
  frozenMs: (Number(process.env.FROZEN_MINUTES) || 30) * 60000,
};

function friendly(msg) {
  if (/rejected/i.test(msg)) return 'UltraVNC rechazó la conexión (bloqueo temporal por intentos o filtro de IP)';
  if (/contraseña vnc rechazada|autenticaci[oó]n rechazada/i.test(msg)) return 'Contraseña incorrecta: edita el equipo y pon la suya';
  return msg;
}

class Monitor {
  constructor(devices, { port = 5900, password = '', intervalMs = 90000, concurrency = 6, thumbWidth = 480 } = {}) {
    this.devices = devices;
    this.opts = { port, password, intervalMs, concurrency, thumbWidth };
    this.status = {}; // ip -> { online, lastSeen, checkedAt }
    this.thumbs = {}; // ip -> { jpeg, takenAt, width, height }
    this.errors = {}; // ip -> { message, at }
    this.sigs = {};   // ip -> { sig, at, changedAt }
    // Colores de fondo del escritorio de Windows (NG-Client no visible): los de fábrica + los marcados
    this.desktopColors = [...HEALTH.defaultDesktopColors];
    this.running = false;
  }

  forget(ip) {
    delete this.status[ip];
    delete this.thumbs[ip];
    delete this.errors[ip];
    delete this.sigs[ip];
  }

  // Alertas de una firma: escritorio visible, negra/en blanco, o distinta a su referencia
  issuesOf(d, sig) {
    const lum = luminance(sig);
    const desktop = Math.max(0, ...this.desktopColors.map((c) => colorFraction(sig, c)));
    const baseline = d.baseline ? Buffer.from(d.baseline, 'base64') : null;
    const baselineDiff = sigDiff(sig, baseline);
    let issue = null;
    if (desktop >= HEALTH.desktopFraction) issue = 'desktop';
    else if (lum.std < 3) issue = lum.mean < 30 ? 'black' : 'blank'; // un solo color
    else if (baselineDiff !== null && baselineDiff > HEALTH.baselineDiff) issue = 'baseline';
    return { issue, desktop, baselineDiff };
  }

  // Estado de la pantalla deducido de las dos últimas capturas
  health(d) {
    const s = this.sigs[d.ip];
    if (!s || !this.status[d.ip]?.online) return null;
    const cur = this.issuesOf(d, s.sig);
    // Una alerta cuenta solo si se repite en dos capturas seguidas: evita falsas alarmas
    // por transiciones de anuncios (pantalla en blanco un instante) o NG-Client reiniciando.
    const prev = s.prev ? this.issuesOf(d, s.prev).issue : null;
    const issues = cur.issue && cur.issue === prev ? [cur.issue] : [];
    const desktop = cur.desktop;
    const baselineDiff = cur.baselineDiff;
    return {
      issues,
      pending: cur.issue && !issues.length ? cur.issue : null, // vista una vez, por confirmar
      level: issues.length ? 'warn' : 'ok',
      unchangedSince: s.changedAt,
      frozen: Date.now() - s.changedAt > HEALTH.frozenMs,
      desktopPct: Math.round(desktop * 100),
      baselineDiff: baselineDiff === null ? null : Math.round(baselineDiff * 10) / 10,
    };
  }

  async capture(ip) {
    const d = this.devices.find((x) => x.ip === ip);
    if (!d) return;
    const prev = this.status[ip] || {};
    try {
      const frame = await grabFrame(ip, d.port || this.opts.port, d.password || this.opts.password);
      const [jpeg, sig] = await Promise.all([toJpeg(frame, this.opts.thumbWidth), signature(frame)]);
      this.thumbs[ip] = { jpeg, takenAt: Date.now(), width: frame.width, height: frame.height };
      const old = this.sigs[ip];
      this.sigs[ip] = { sig, prev: old?.sig || null, at: Date.now(), changedAt: changed(old?.sig, sig) ? Date.now() : old.changedAt };
      this.status[ip] = { online: true, lastSeen: Date.now(), checkedAt: Date.now() };
      delete this.errors[ip];
    } catch (e) {
      const online = !e.offline;
      this.status[ip] = { online, lastSeen: online ? Date.now() : prev.lastSeen || null, checkedAt: Date.now() };
      if (online) this.errors[ip] = { message: friendly(e.message), at: Date.now() };
      else delete this.errors[ip];
    }
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    const queue = this.devices.map((d) => d.ip);
    const worker = async () => {
      while (queue.length) await this.capture(queue.shift());
    };
    await Promise.all(Array.from({ length: this.opts.concurrency }, worker));
    this.running = false;
  }

  start() {
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.opts.intervalMs);
  }
}

module.exports = { Monitor, toJpeg, friendly, dominantColor, HEALTH };
