// Lee el Excel de inventario FIDS y devuelve la lista de equipos
const ExcelJS = require('exceljs');

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

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v).trim();
}

// Grupo a partir del nombre: SAP-CK-01-02 -> CK, SAP-GATED-06 -> GATE
function groupOf(name) {
  const m = /^SAP-([A-Za-z]+)/i.exec(name || '');
  let key = m ? m[1].toUpperCase() : 'OTROS';
  if (key === 'GATED') key = 'GATE';
  if (!GROUPS[key]) key = 'OTROS';
  return { group: key, groupLabel: GROUPS[key] };
}

async function parseWorkbook(source) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source)) await wb.xlsx.load(source);
  else await wb.xlsx.readFile(source);
  const ws = wb.worksheets[0];

  // Localiza la fila de encabezados y las columnas por nombre
  let headerRow = 0;
  const col = {};
  ws.eachRow((row, n) => {
    if (headerRow) return;
    row.eachCell((cell, c) => {
      const t = cellText(cell.value).toLowerCase();
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

  const devices = [];
  let maker = '', model = '', controller = '';
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const get = (c) => (c ? cellText(row.getCell(c).value) : '');
    const name = get(col.name);
    const ip = get(col.ip);
    // Fabricante/modelo/controlador vienen en celdas combinadas: se arrastran hacia abajo
    maker = get(col.maker) || maker;
    model = get(col.model) || model;
    controller = get(col.controller) || controller;
    if (!/^SAP-/i.test(name) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const g = groupOf(name);
    // Los equipos en espera comparten nombre (celda combinada): se distinguen por el último octeto
    const unique = devices.some((d) => d.name === name) || g.group === 'ESPERA'
      ? `${name}-${ip.split('.').pop()}`
      : name;
    devices.push({ name: unique, description: get(col.desc), maker, model, ip, controller, ...g });
  }
  return devices;
}

module.exports = { parseWorkbook, groupOf, GROUPS };
