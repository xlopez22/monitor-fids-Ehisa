// Convierte el Excel de inventario FIDS en data/inventory.json (conserva los equipos agregados a mano)
// Uso: npm run import -- "C:\ruta\SAP Inventario.xlsx"
// También se puede importar desde el tablero: botón "Importar Excel".
const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../lib/excel');
const { Store } = require('../lib/store');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Indica la ruta del Excel: npm run import -- "ruta.xlsx"');
    process.exit(1);
  }
  const store = new Store(process.env.INVENTORY_FILE || path.join(__dirname, '..', 'data', 'inventory.json'));
  const r = store.merge(await parseWorkbook(fs.readFileSync(file)));
  console.log(`${store.devices.length} equipos (${r.added} nuevos, ${r.updated} actualizados) -> ${store.file}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
