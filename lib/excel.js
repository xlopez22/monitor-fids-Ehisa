// Lee el Excel de inventario FIDS y devuelve la lista de equipos
const net = require('net');
const ExcelJS = require('exceljs');
const { inspectZip } = require('./zip-inspect');

const GROUPS = {
  CK: 'Check-in',
  GATE: 'Gates',
  BAGS: 'Bandas de equipaje',
  LEDS: 'Pantallas LED',
  TOTE: 'Tótems',
  VWAL: 'Video walls',
  GENA: 'Información general',
  OPSC: 'Centro de operaciones',
  VIPL: 'Salas VIP',
  SPAR: 'Food court',
  DSEAL: 'Migración / Sellos',
  ESPERA: 'En espera',
  OTROS: 'Otros',
};

// Límites del libro: una importación normal tiene cientos de filas, no millones.
const DEFAULT_LIMITS = Object.freeze({
  maxSheets: 20,
  maxRows: 20_000,
  maxColumns: 100,
  maxCells: 200_000,
  maxDevices: 5_000,
  maxName: 128,
  maxField: 128,
  maxController: 256,
  maxText: 4_096,
});

function clip(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function cellText(v, max = Infinity) {
  let s;
  if (v == null) s = '';
  else if (typeof v === 'object') {
    if (v.richText) s = v.richText.slice(0, 200).map((r) => String(r.text ?? '')).join('');
    else if (v.text != null) s = String(v.text);
    else if (v.result != null) s = String(v.result);
    else s = String(v);
  } else {
    s = String(v);
  }
  return max === Infinity ? s.trim() : clip(s, max);
}

// Grupo a partir del nombre: SAP-CK-01-02 -> CK, SAP-GATED-06 -> GATE
function groupOf(name) {
  const m = /^SAP-([A-Za-z]+)/i.exec(name || '');
  let key = m ? m[1].toUpperCase() : 'OTROS';
  if (key === 'GATED') key = 'GATE';
  if (!GROUPS[key]) key = 'OTROS';
  return { group: key, groupLabel: GROUPS[key] };
}

async function parseWorkbook(source, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!Buffer.isBuffer(source)) throw new Error('El archivo debe ser un XLSX.');
  // Valida firma ZIP, hojas y tamaño real descomprimido antes de cargar ExcelJS
  inspectZip(source, { maxSheets: limits.maxSheets, ...(options.zip || {}) });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(source);
  } catch (e) {
    throw new Error(`No se pudo leer el XLSX: ${e.message}`);
  }
  if (wb.worksheets.length > limits.maxSheets) throw new Error('El XLSX tiene demasiadas hojas.');
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El XLSX no contiene hojas de cálculo.');
  if (ws.rowCount > limits.maxRows) {
    throw new Error(`El XLSX tiene demasiadas filas (${ws.rowCount}; máximo ${limits.maxRows}).`);
  }
  if (ws.columnCount > limits.maxColumns) {
    throw new Error(`El XLSX tiene demasiadas columnas (${ws.columnCount}; máximo ${limits.maxColumns}).`);
  }
  if (ws.rowCount * ws.columnCount > limits.maxCells) {
    throw new Error(`El XLSX tiene demasiadas celdas (máximo ${limits.maxCells}).`);
  }

  // Localiza la fila de encabezados y las columnas por nombre
  let headerRow = 0;
  const col = {};
  ws.eachRow((row, n) => {
    if (headerRow) return;
    row.eachCell((cell, c) => {
      const t = cellText(cell.value, 64).toLowerCase();
      if (t.startsWith('name')) col.name = c;
      else if (t === 'description') col.desc = c;
      else if (t === 'manufacturer') col.maker = c;
      else if (t === 'model') col.model = c;
      else if (t === 'ip address') col.ip = c;
      else if (t.startsWith('location of the controller')) col.controller = c;
    });
    if (col.name && col.ip) headerRow = n;
  });
  if (!headerRow) throw new Error('No se encontraron encabezados "Name" e "IP Address"');

  const byIp = new Map();
  const names = new Set();
  let maker = '', model = '', controller = '';
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const get = (c, max) => (c ? cellText(row.getCell(c).value, max) : '');
    const name = get(col.name, limits.maxName);
    const ip = get(col.ip, 64);
    // Fabricante/modelo/controlador vienen en celdas combinadas: se arrastran hacia abajo
    maker = get(col.maker, limits.maxField) || maker;
    model = get(col.model, limits.maxField) || model;
    controller = get(col.controller, limits.maxController) || controller;
    if (!/^SAP-/i.test(name) || net.isIP(ip) !== 4) continue;
    const g = groupOf(name);
    const description = get(col.desc, limits.maxText);
    // Los equipos en espera comparten nombre (celda combinada): se distinguen por el último octeto
    const base = names.has(name) || g.group === 'ESPERA' ? `${name}-${ip.split('.').pop()}` : name;
    let unique = base;
    for (let i = 2; names.has(unique); i++) unique = `${base}-${i}`;
    names.add(unique);
    byIp.set(ip, { name: unique, description, maker, model, ip, controller, ...g });
    if (byIp.size > limits.maxDevices) {
      throw new Error(`El Excel tiene demasiados equipos (máximo ${limits.maxDevices}).`);
    }
  }
  return [...byIp.values()];
}

module.exports = { parseWorkbook, groupOf, GROUPS, DEFAULT_EXCEL_LIMITS: DEFAULT_LIMITS };
