// Inventario de equipos guardado en un JSON. Cada equipo puede tener su propia contraseña VNC
// (si no, se usa VNC_PASSWORD). La contraseña nunca sale por la API: solo "hasPassword".
const fs = require('fs');
const path = require('path');
const { groupOf } = require('./excel');
const { encrypt, decrypt, isEncrypted } = require('./password-enc');

const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

class Store {
  constructor(file) {
    this.file = file;
    let rawDevices = [];
    if (fs.existsSync(file)) {
      try {
        rawDevices = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`Inventario inválido (${file}): ${e.message}`);
      }
      if (!Array.isArray(rawDevices)) throw new Error(`Inventario inválido (${file}): se esperaba una lista de equipos.`);
    }
    // Descifrar contraseñas al cargar
    this.devices = rawDevices.map(d => ({
      ...d,
      password: decrypt(d.password)
    }));

    // VNC solo usa los primeros 8 caracteres: avisar si quedó alguna más larga.
    const longPasswords = this.devices.filter((d) => d.password && String(d.password).length > 8).length;
    if (longPasswords) {
      console.warn(`[store] ${longPasswords} contraseña(s) VNC tienen más de 8 caracteres; VNC solo usa los primeros 8.`);
    }

    // Inventarios anteriores: las contraseñas estaban en texto plano. Se reescriben
    // cifradas en la primera carga (si falta DATA_ENCRYPTION_KEY, save() falla con un
    // mensaje claro en lugar de seguir guardando secretos sin cifrar).
    if (rawDevices.some((d) => d.password && !isEncrypted(d.password))) {
      this.save();
      console.log(`[store] Contraseñas del inventario migradas a cifrado en reposo (${file})`);
    }

    // Ajustes generales junto al inventario (referencias de "escritorio de Windows")
    this.settingsFile = path.join(path.dirname(file), 'settings.json');
    this.settings = fs.existsSync(this.settingsFile) ? JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) : {};
    this.settings.desktopRefs ||= [];
  }

  static writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  save() {
    // En disco las contraseñas van siempre cifradas; en memoria quedan en claro para
    // que el monitor y el proxy VNC las usen sin descifrar en cada ronda.
    const dataToSave = this.devices.map((d) => {
      const out = { ...d };
      if (out.password) out.password = encrypt(out.password);
      else delete out.password;
      return out;
    });
    Store.writeJson(this.file, dataToSave);
  }

  saveSettings() {
    Store.writeJson(this.settingsFile, this.settings);
  }

  // Referencia de pantalla "normal" de un equipo (firma 32x18 en base64), o null para quitarla
  setBaseline(ip, sigB64) {
    const d = this.get(ip);
    if (!d) throw new Error('Equipo no encontrado');
    if (sigB64) d.baseline = sigB64; else delete d.baseline;
    this.save();
  }

  // Color de fondo del escritorio de Windows tomado de un equipo que lo está mostrando
  addDesktopRef(ip, color) {
    this.settings.desktopRefs.push({ from: ip, at: Date.now(), color });
    this.saveSettings();
  }

  clearDesktopRefs() {
    this.settings.desktopRefs = [];
    this.saveSettings();
  }

  get(ip) {
    return this.devices.find((d) => d.ip === ip);
  }

  // Valida y normaliza lo que llega del formulario
  clean(input, existing) {
    const ip = String(input.ip ?? existing?.ip ?? '').trim();
    if (!IP_RE.test(ip)) throw new Error('IP no válida');
    const name = String(input.name ?? existing?.name ?? '').trim() || `EQUIPO-${ip.split('.').pop()}`;
    const g = input.group ? { group: input.group, groupLabel: input.groupLabel || groupOf(`SAP-${input.group}`).groupLabel } : groupOf(name);
    const d = {
      ...existing,
      name,
      description: String(input.description ?? existing?.description ?? '').trim(),
      ip,
      ...g,
    };
    const port = Number(input.port);
    if (port > 0 && port < 65536 && port !== 5900) d.port = port; else delete d.port;
    if (input.password) {
      const password = String(input.password);
      if (password.length > 8) {
        throw new Error('La contraseña VNC usa máximo 8 caracteres (límite del protocolo VNC).');
      }
      d.password = password;
    }
    if (input.clearPassword) delete d.password;
    return d;
  }

  add(input) {
    const d = this.clean(input);
    if (this.get(d.ip)) throw new Error(`Ya existe un equipo con IP ${d.ip}`);
    d.manual = true;
    this.devices.push(d);
    this.save();
    return d;
  }

  update(ip, input) {
    const i = this.devices.findIndex((d) => d.ip === ip);
    if (i < 0) throw new Error('Equipo no encontrado');
    const d = this.clean(input, this.devices[i]);
    if (d.ip !== ip && this.get(d.ip)) throw new Error(`Ya existe un equipo con IP ${d.ip}`);
    this.devices[i] = d;
    this.save();
    return d;
  }

  remove(ip) {
    const i = this.devices.findIndex((d) => d.ip === ip);
    if (i < 0) throw new Error('Equipo no encontrado');
    this.devices.splice(i, 1);
    this.save();
  }

  // Agrega/actualiza equipos del Excel por IP; conserva contraseñas y equipos agregados a mano
  merge(list) {
    let added = 0, updated = 0;
    for (const x of list) {
      const cur = this.get(x.ip);
      if (cur) { Object.assign(cur, x, { manual: false }); updated++; }
      else { this.devices.push(x); added++; }
    }
    this.save();
    return { added, updated };
  }

  // Vista pública (sin contraseña)
  static public(d) {
    const { password, baseline, ...rest } = d;
    return { ...rest, hasPassword: Boolean(password), hasBaseline: Boolean(baseline) };
  }
}

module.exports = { Store, IP_RE };
