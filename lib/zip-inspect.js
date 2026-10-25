// Inspección defensiva de un XLSX antes de entregarlo a ExcelJS.
// Un XLSX es un ZIP: se valida la firma, se leen los tamaños reales y se
// descomprime cada entrada con un máximo, para que un archivo pequeño no pueda
// inflarse hasta agotar la memoria. También se limitan hojas, entradas y nombres.
const zlib = require('zlib');

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 512,
  maxSheets: 20,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxNameLength: 512,
});

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64 = 0xffffffff;

function fail(message) {
  throw new Error(message);
}

function inspectZip(buf, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('El archivo no es un XLSX válido.');
  if (buf.readUInt32LE(0) !== LOCAL_SIG) fail('El archivo no es un XLSX válido (no es un ZIP).');

  // El fin del directorio central está en los últimos 65.557 bytes (comentario máximo)
  const first = Math.max(0, buf.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buf.length - 22; i >= first; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) fail('El archivo no es un XLSX válido (falta el índice ZIP).');

  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesDisk = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesDisk !== entries) fail('XLSX con varias partes no soportado.');
  if (entries === 0) fail('El XLSX está vacío.');
  if (entries > limits.maxEntries) fail(`El XLSX tiene demasiadas entradas (${entries}; máximo ${limits.maxEntries}).`);
  if (cdOffset + cdSize > buf.length) fail('El índice ZIP del XLSX está truncado.');

  const seen = new Set();
  let sheets = 0;
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) fail('El índice ZIP del XLSX está dañado.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > buf.length || nameLen > limits.maxNameLength) fail('El índice ZIP del XLSX está dañado.');
    if (flags & 1) fail('El XLSX está cifrado; quita la contraseña antes de importarlo.');
    if (method !== 0 && method !== 8) fail(`Compresión ZIP no soportada (${method}).`);
    if (compressed === ZIP64 || declared === ZIP64) fail('XLSX ZIP64 no soportado; guarda el archivo en formato XLSX normal.');

    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (!name || name.startsWith('/') || name.split('/').includes('..')) fail('El XLSX contiene una ruta no válida.');
    if (seen.has(name)) fail(`El XLSX contiene una entrada repetida: ${name}`);
    seen.add(name);
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) sheets++;

    // Los tamaños del directorio central pueden mentir: se descomprime de verdad
    // con un tope y se compara con lo declarado.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) fail('El XLSX tiene una entrada dañada.');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressed;
    if (dataEnd > buf.length) fail('El XLSX tiene datos truncados.');

    let actual = declared;
    if (name.endsWith('/')) {
      actual = 0;
    } else if (method === 0) {
      actual = compressed;
    } else {
      try {
        actual = zlib.inflateRawSync(buf.subarray(dataStart, dataEnd), {
          maxOutputLength: limits.maxEntryBytes,
        }).length;
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE') {
          fail(`Una parte del XLSX supera el máximo descomprimido (${limits.maxEntryBytes} bytes).`);
        }
        fail('El XLSX tiene una parte comprimida inválida.');
      }
    }
    if (actual !== declared) fail('El XLSX declara tamaños que no coinciden con su contenido.');
    if (actual > limits.maxEntryBytes) fail(`Una parte del XLSX supera el máximo (${limits.maxEntryBytes} bytes).`);
    total += actual;
    if (total > limits.maxTotalBytes) fail(`El XLSX supera el máximo descomprimido (${limits.maxTotalBytes} bytes).`);

    p = next;
  }
  if (sheets === 0) fail('El XLSX no contiene hojas de cálculo.');
  if (sheets > limits.maxSheets) fail(`El XLSX tiene demasiadas hojas (${sheets}; máximo ${limits.maxSheets}).`);
  return { entries, sheets, uncompressedBytes: total };
}

module.exports = { inspectZip, DEFAULT_ZIP_LIMITS: DEFAULT_LIMITS };
