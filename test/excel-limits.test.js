const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { parseWorkbook, DEFAULT_EXCEL_LIMITS } = require('../lib/excel');
const { inspectZip } = require('../lib/zip-inspect');

const HEADERS = ['Name', 'Description', 'Manufacturer', 'Model', 'IP Address', 'Location of the controller'];

async function makeXlsx(rows, sheetCount = 1, extraSheets = []) {
  const wb = new ExcelJS.Workbook();
  for (let i = 0; i < sheetCount; i++) {
    const ws = wb.addWorksheet(`Hoja ${i + 1}`);
    ws.addRow(HEADERS);
    if (i === 0) for (const row of rows) ws.addRow(row);
  }
  for (const name of extraSheets) wb.addWorksheet(name).addRow(['x']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const CK = ['SAP-CK-01', 'Mostrador 1', 'ASUS', 'NUC-12', '192.168.1.10', ''];
const GATE = ['SAP-GATE-01', 'Puerta 1', 'DELL', 'Optiplex', '192.168.1.11', ''];

test('parseWorkbook lee un XLSX normal y deduce la zona', async () => {
  const buf = await makeXlsx([CK, GATE]);
  const devices = await parseWorkbook(buf);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].ip, '192.168.1.10');
  assert.equal(devices[0].group, 'CK');
  assert.equal(devices[0].groupLabel, 'Check-in');
  assert.equal(devices[1].group, 'GATE');
});

test('parseWorkbook ignora IPs inválidas y deduplica por IP', async () => {
  const buf = await makeXlsx([
    CK,
    ['SAP-CK-02', 'Inválida', 'ASUS', 'NUC', '999.999.999.999', ''],
    ['SAP-CK-03', 'Duplicada', 'ASUS', 'NUC', '192.168.1.10', ''],
  ]);
  const devices = await parseWorkbook(buf);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].ip, '192.168.1.10');
  assert.equal(devices[0].name, 'SAP-CK-03');
});

test('parseWorkbook aplica límites de filas, equipos y texto', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => [`SAP-CK-0${i + 1}`, 'x', 'ASUS', 'NUC', `192.168.1.${10 + i}`, '']);
  const buf = await makeXlsx(rows);
  await assert.rejects(parseWorkbook(buf, { maxRows: 3 }), /demasiadas filas/);
  await assert.rejects(parseWorkbook(buf, { maxDevices: 2 }), /demasiados equipos/);

  const long = await makeXlsx([['SAP-CK-01', '1234567890', 'ASUS', 'NUC', '192.168.1.10', '']]);
  const devices = await parseWorkbook(long, { maxText: 5 });
  assert.equal(devices[0].description, '12345');
});

test('inspectZip acepta un XLSX normal y rechaza archivos que no son ZIP', async () => {
  const buf = await makeXlsx([CK]);
  const info = inspectZip(buf);
  assert.ok(info.entries > 0);
  assert.equal(info.sheets, 1);
  assert.throws(() => inspectZip(Buffer.from('esto no es un xlsx en absoluto, pero tiene más de 22 bytes')), /no es un XLSX/);
});

test('inspectZip limita la cantidad de hojas', async () => {
  const buf = await makeXlsx([CK], 1, ['Otra 1', 'Otra 2']);
  assert.throws(() => inspectZip(buf, { maxSheets: 2 }), /demasiadas hojas/);
});

test('inspectZip corta una bomba de descompresión', async () => {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', Buffer.alloc(1024 * 1024, 0));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.throws(() => inspectZip(buf, { maxEntryBytes: 1024 }), /máximo descomprimido|supera el máximo/);
});

test('inspectZip detecta tamaños declarados que mienten', async () => {
  const zip = new JSZip();
  const name = 'xl/worksheets/sheet1.xml';
  zip.file(name, Buffer.alloc(64 * 1024, 0));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const patched = Buffer.from(buf);
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let pos = 0;
  let found = false;
  while ((pos = patched.indexOf(sig, pos)) !== -1) {
    const nameLen = patched.readUInt16LE(pos + 28);
    const entry = patched.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (entry === name) {
      patched.writeUInt32LE(10, pos + 24); // dice 10 bytes, en realidad son 64 KB
      found = true;
      break;
    }
    pos += 4;
  }
  assert.ok(found, 'no se encontró la entrada central');
  assert.throws(() => inspectZip(patched), /no coinciden/);
});

test('inspectZip rechaza un ZIP sin hojas', async () => {
  const zip = new JSZip();
  zip.file('foo.txt', 'hola');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  assert.throws(() => inspectZip(buf), /no contiene hojas/);
});

test('los límites por defecto son razonables para el inventario real', () => {
  assert.ok(DEFAULT_EXCEL_LIMITS.maxRows >= 1000);
  assert.ok(DEFAULT_EXCEL_LIMITS.maxDevices >= 1000);
  assert.ok(DEFAULT_EXCEL_LIMITS.maxColumns >= 10);
});
