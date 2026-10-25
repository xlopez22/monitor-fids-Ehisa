# FIDS Monitor

Panel web local para ver de un vistazo los reproductores FIDS (SAP-CK, GATE, BAGS, LEDS, TOTE, VWAL, GENA, OPSC, VIPL, SPAR, DSEAL…) y abrir cualquiera en vivo desde el navegador, sin instalar nada en los equipos: usa el UltraVNC que ya tienen (puerto 5900). Pide una contraseña local (una por instalación) antes de mostrar el tablero o el visor.

## Qué hace

**Tablero**
- Todos los equipos agrupados por zona, con estado (en línea / caído / con error), miniatura de la pantalla y hace cuánto se tomó.
- Vista **Cuadrícula** o **Lista** (tabla con miniatura chica, IP, resolución, error).
- Filtro de estado: **Todos / En línea / Caídos / Con error / Revisar**, filtro por zona y buscador. La vista y los filtros se recuerdan.
- Los equipos **caídos** no abren el visor; tienen **Intentar de todos modos** (por si acaban de encender). El intento falla en ~4 s si siguen sin responder.
- **Salud de la pantalla** (deducida de la imagen, sin instalar nada):
  - **⚠ NG-Client no visible**: se ve el escritorio de Windows (fondo azul 4,100,180 en ≥ 30 % de la pantalla). Calibrado con SAP-OPSC-04: el escritorio da 97 %, los tableros y logos ≤ 8 %. Si algún equipo tiene otro fondo, en ✎ → Pantalla → "Esto es el escritorio" se agrega su color.
  - **⚠ Pantalla negra / en blanco**: un solo color en toda la pantalla.
  - **⚠ Distinta a lo normal**: solo si marcaste ✎ → Pantalla → "Así se ve normal" en ese equipo. Útil en pantallas de diseño fijo (tableros GENA, tótems); no en check-in, que cambia de logo según la aerolínea.
  - Una alerta solo aparece si se repite en **dos capturas seguidas** (evita falsas alarmas por transiciones de anuncios).
  - **⏸ sin cambios hace X** (informativo): la imagen no cambió en `FROZEN_MINUTES` (30). Hay pantallas estáticas a propósito, por eso no es alerta.
  - Es una deducción por imagen: no ve el proceso NG-Client.exe. Para saberlo con certeza haría falta acceso de administrador (WinRM) o la consola del servidor DDS.
- **↻** en cada equipo vuelve a sacar su miniatura; **↻ Actualizar todo** revisa todos ya.
- **✎** edita un equipo: nombre, IP, ubicación, zona, puerto y **contraseña VNC propia** (para equipos que no usan la general). También se elimina desde ahí.
- **＋ Agregar equipo** para los que no están en el Excel.
- **Buscar equipos nuevos**: revisa la red (por defecto las /24 del inventario, p. ej. 192.168.10.x) buscando VNC abierto en IPs que no están en la lista, prueba la contraseña general y muestra una miniatura de cada uno, con botón para agregarlo.
- **Importar Excel**: sube el Excel de inventario; agrega los nuevos y actualiza los existentes por IP, sin borrar los agregados a mano ni las contraseñas propias.

**Visor en vivo** (clic en la miniatura o el nombre)
- **← Tablero** cierra la sesión y vuelve (**Alt+←** solo cuando no estás controlando).
- **Solo observar por defecto**, y lo impone el servidor: el visor nace en solo lectura y descarta teclado, ratón y portapapeles. **Tomar control** pide permiso al servidor (POST autenticado y con CSRF, ligado a esta sesión y a esta conexión WebSocket) y, si lo concede, pone pantalla completa con bloqueo de teclado: todas las teclas (Windows, Alt+Tab, Esc…) van al equipo. Para soltar: mantener Esc o el botón. Al tomar control se activa **⚡ Rápido** (calidad 1, compresión 9); el mismo botón vuelve a calidad normal. Al soltar, cerrar o recargar vuelve a solo lectura.
- **Ctrl / Alt / Shift / ⊞** se quedan presionados con un clic y se sueltan con otro (para Ctrl+clic, etc.). Se sueltan solos al soltar el control o salir.
- Atajos: ⊞ Win, Alt+Tab, Esc, Ctrl+Esc, Ctrl+C, Ctrl+V, Ctrl+Alt+Supr.
- **Copiar y pegar** (solo texto): lo que copias en el equipo llega a tu portapapeles, también en solo observar. Pegar en el equipo (Ctrl+V o el botón) solo funciona con control activo. Chrome pide permiso de portapapeles la primera vez. Depende de que UltraVNC tenga activada la transferencia de portapapeles en ese equipo.
- **↻ NG-Client** (en modo control, con confirmación): usa Ejecutar (Win+R) dos veces. Primero `NG_CLIENT_KILL` (`taskkill /f /im ng-client.exe`) y luego `NG_CLIENT_START` (`c:\dds\ng-client\ng-client.exe --fids-allow-invalid-cert`), igual que "START DDS CLIENT". La orden se **teclea** (no se pega), porque el portapapeles de UltraVNC no siempre pasa, y antes se borra lo que tuviera Ejecutar, así nunca se lanza una orden vieja. Probado en SAP-OPSC-04 (22/10/2026): NG-Client volvió a pantalla completa.
- **Puntero**: Del equipo / Flecha (22 px, por defecto) / Grande (30) / Muy grande (40).
- Calidad y compresión ajustables, pantalla completa, reconectar.
- Si no conecta, dice por qué (contraseña incorrecta, bloqueo de UltraVNC, equipo sin respuesta).

## Con Docker (recomendado)

Requiere Docker Desktop.

```
copy .env.example .env
```

Edita `.env` y pon la contraseña VNC general en `VNC_PASSWORD=`. Después configura la contraseña del panel (mínimo 12 caracteres):

```
npm run set-password
```

Si no tienes Node.js instalado, puedes generarla con un contenedor temporal:

```
docker run --rm -it -v "${PWD}:/app" -w /app node:22 node scripts/set-password.js
```

Luego:

```
docker compose up -d --build
```

Abre http://127.0.0.1:8080 e introduce la contraseña del panel.

- El contenedor se reinicia solo con Docker (`restart: unless-stopped`).
- El inventario vive en el volumen de Docker `fids-data` (montado en `/app/data`). El volumen nace vacío: importa tu Excel o agrega los equipos desde el tablero. Sobrevive a `docker compose down` y a reconstruir la imagen. Solo se borra con `docker compose down -v`. La imagen no incluye `data/`, así que un `inventory.json` real nunca queda empaquetado.
- Ver registros: `docker compose logs -f`
- Detener: `docker compose down`
- Copia de seguridad del inventario: `docker cp fids-monitor:/app/data/inventory.json respaldo.json`
- Solo es accesible desde esta PC (`127.0.0.1:8080`). Para abrirlo a otras PCs de la red, cambia el puerto en `docker-compose.yml` a `"8080:8080"` y agrega el host/origen usado en `APP_HOSTS` y `APP_ORIGINS`. Sin HTTPS, la contraseña y la sesión viajan sin cifrar: para la LAN es recomendable ponerlo detrás de un reverse proxy con TLS y activar `COOKIE_SECURE=true`.

## Sin Docker

Node.js 18 o superior.

```
npm install
copy .env.example .env
npm run set-password
npm start
```

`set-password` pide la contraseña dos veces y guarda solo su hash scrypt, un `SESSION_SECRET` y una `DATA_ENCRYPTION_KEY` en `.env`. La clave de cifrado se conserva si ya existía: cambiar la contraseña del panel no deja ilegibles las contraseñas VNC guardadas. Si la olvidas, vuelve a ejecutarlo; las sesiones abiertas se invalidan. Para importar el Excel por línea de comandos: `npm run import -- "C:\ruta\inventario.xlsx"`.

## Cómo funciona

- **Una sesión por equipo y ronda.** Cada `ROUND_SECONDS` (90 s) se abre una sesión VNC normal, compartida y de solo lectura con cada equipo, de a `CONCURRENCY` (6) a la vez. Si el puerto abre, el equipo está en línea, y en esa misma sesión se pide un cuadro completo que se reduce a JPEG. Una ronda de ~96 equipos tarda ~50 s.
- **Sin sondeos sueltos al puerto 5900.** UltraVNC cuenta como intento fallido cada conexión que se cierra sin autenticar, y después de varios bloquea un rato la IP con *"Your connection has been rejected."*. Por eso el estado sale de la misma sesión que toma la miniatura. El ping tampoco sirve: el firewall de Windows de los equipos no responde ICMP. "Buscar equipos nuevos" sí hace un intento TCP por IP, pero solo cuando lo pides.
- **Visor en vivo**: el navegador habla con este servidor por WebSocket (`/ws/<ip>?conn=<id>`) y el servidor con el equipo por TCP. Las contraseñas se usan solo en el servidor; el navegador nunca las ve y la API solo dice si un equipo tiene contraseña propia. Solo se permiten IPs del inventario. El visor arranca en solo lectura y el servidor filtra los mensajes RFB: teclado, ratón y portapapeles solo se reenvían mientras esa conexión tiene control.
- Las sesiones son **compartidas**: no desconectan a otros que estén mirando con UltraVNC.

## VNC seguro (TLS)

El VNC clásico **no cifra la pantalla ni las teclas**, y su login usa DES con contraseñas de máximo 8 caracteres. Este panel puede envolver el flujo RFB en TLS si delante de cada equipo hay un `stunnel` (o un gateway TLS equivalente):

- El panel conecta por TLS al mismo host/puerto del inventario.
- `stunnel` termina TLS y reenvía a UltraVNC en `127.0.0.1:5901`.
- Dentro del túnel sigue el VNC clásico; TLS protege el tránsito y valida el certificado del equipo.

Ejemplo de `stunnel.conf` en cada equipo FIDS (UltraVNC movido al 5901):

```ini
[vnc]
accept = 5900
connect = 127.0.0.1:5901
cert = C:\stunnel\fids.pem
key = C:\stunnel\fids.key
```

En el panel:

```env
VNC_TLS=1
VNC_TLS_CA=C:\fids-monitor\certs\fids-ca.pem
```

- `VNC_TLS_CA` debe contener la CA que firmó los certificados. Si usás un certificado autofirmado por equipo, podés concatenar todos los `.pem` en un solo archivo.
- El certificado debe incluir la **IP del equipo** en `subjectAltName` (o usar `VNC_TLS_SERVERNAME` si el certificado usa un nombre).
- `VNC_TLS_INSECURE=1` desactiva la validación y solo sirve para probar: no protege contra un equipo falso (MITM).
- En Docker, montá el PEM dentro del contenedor y usá esa ruta, por ejemplo `- ./certs:/app/certs:ro` y `VNC_TLS_CA=/app/certs/fids-ca.pem`.

Si no podés desplegar TLS en los equipos, la alternativa es aislar la VLAN de FIDS y permitir el 5900 **solo** desde la PC del panel; sin eso, cualquiera en la misma red puede ver las pantallas o capturar el handshake VNC.

La contraseña VNC (general o por equipo) usa **máximo 8 caracteres**: el panel rechaza contraseñas más largas al editar un equipo y avisa si `VNC_PASSWORD` es más larga.

## Configuración (.env)

| Variable | Defecto | Uso |
|---|---|---|
| `AUTH_PASSWORD_HASH` | — | Hash scrypt de la contraseña del panel; lo genera `npm run set-password` |
| `SESSION_SECRET` | — | Secreto para firmar la cookie de sesión; lo genera `npm run set-password` |
| `DATA_ENCRYPTION_KEY` | — | Clave AES-256-GCM (32 bytes base64) para cifrar las contraseñas VNC del inventario; no rotarla sin volver a cargarlas |
| `APP_HOSTS` | `127.0.0.1:PORT,localhost:PORT` | Hosts permitidos en la cabecera `Host` (separados por coma) |
| `APP_ORIGINS` | `http://127.0.0.1:PORT,http://localhost:PORT` | Orígenes permitidos para peticiones y WebSocket (separados por coma) |
| `COOKIE_SECURE` | `false` | `true` si el panel va detrás de HTTPS |
| `TRUST_PROXY` | `false` | `1` si hay un reverse proxy delante |
| `VNC_PASSWORD` | — | Contraseña VNC general (máx. 8 caracteres efectivos) |
| `VNC_TLS` | `false` | `true` para conectar al VNC por TLS (stunnel/gateway delante de cada equipo) |
| `VNC_TLS_CA` | — | Certificado/CA en PEM que valida los certificados de los equipos |
| `VNC_TLS_INSECURE` | `false` | `true` solo para pruebas: no valida el certificado (pierde protección contra MITM) |
| `VNC_TLS_SERVERNAME` | — | Nombre del certificado si no coincide con la IP del equipo |
| `PORT` / `HOST` | 8080 / 127.0.0.1 | Dónde escucha el panel (en Docker, `HOST` es 0.0.0.0) |
| `VNC_PORT` | 5900 | Puerto VNC por defecto (cada equipo puede tener otro) |
| `ROUND_SECONDS` | 90 | Cada cuánto se revisan todos los equipos |
| `CONCURRENCY` | 6 | Sesiones simultáneas durante la ronda |
| `FROZEN_MINUTES` | 30 | Minutos sin cambios para mostrar "⏸ sin cambios" |
| `BASELINE_DIFF` | 35 | Cuánto debe diferir de su referencia "normal" para alertar (0–255) |
| `NG_CLIENT_KILL` | `taskkill /f /im ng-client.exe` | Paso 1 del botón ↻ NG-Client (en Win+R) |
| `NG_CLIENT_START` | `c:\dds\ng-client\ng-client.exe --fids-allow-invalid-cert` | Paso 2 del botón ↻ NG-Client |
| `INVENTORY_FILE` | data/inventory.json | Inventario alterno (p. ej. para pruebas) |

## Notas

- El panel usa una sola contraseña por instalación, sin usuarios ni roles. La cookie de sesión es `HttpOnly` y `SameSite=Strict`, y las peticiones/WebSocket se validan contra `Host` y `Origin`. El servidor no arranca hasta que existan `AUTH_PASSWORD_HASH`, `SESSION_SECRET` y `DATA_ENCRYPTION_KEY`.
- El visor arranca siempre en solo lectura. El servidor descarta teclado, ratón, portapapeles y extensiones peligrosas hasta que la misma sesión pide control con `POST /api/devices/:ip/control` (con CSRF) para una conexión WebSocket viva; al soltar, cerrar o recargar vuelve a solo lectura.
- Usa siempre el mismo nombre para abrir el panel (`localhost` o `127.0.0.1`): la cookie de sesión no se comparte entre ambos.
- La autenticación VNC usa DES, que Node 17+ ya no trae activo: por eso se arranca con `--openssl-legacy-provider`. DES sigue existiendo dentro del túnel si activás `VNC_TLS`; TLS protege el transporte, no cambia el login VNC.
- Sin `VNC_TLS`, VNC clásico no cifra la imagen ni las teclas. Usalo solo en una VLAN aislada y con el 5900 restringido a la PC del panel.
- Las contraseñas propias de cada equipo se guardan cifradas con AES-256-GCM (`enc:v1:...`) en `inventory.json`; la clave vive solo en `.env` (`DATA_ENCRYPTION_KEY`). Los inventarios viejos en texto plano se cifran solos en la primera carga.
- El parser de capturas RFB tiene límites defensivos: resolución máxima 8192×8192 y 16 Mpx, nombre de escritorio 4 KB, texto del servidor 1 MB, 4096 rectángulos por cuadro, 32 MB de ZRLE comprimido y 4×píxeles al descomprimir. Un equipo que anuncie algo mayor falla esa ronda en vez de reservar memoria por el tamaño anunciado. Los WebSocket del visor aceptan frames de hasta 16 MB y el JSON de la API hasta 64 KB.
- Límites de uso por IP: API pública (login, sesión, CSRF y token WS) 300/min; el login además 5/min; API general 300/min; escaneo 5 cada 10 min; importación 5 cada 10 min; refresco individual 30/min; ronda completa 2/min; control 60/min; mutaciones 60/min; conexiones WebSocket 30/min. Al pasarse, la API responde 429 con JSON y `Retry-After`, y el upgrade WebSocket responde 429 y cierra.
- Las páginas usan una CSP estricta (`script-src 'self'`, sin scripts inline), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`. El JS del visor vive en `public/view.js` y sus estilos en `public/view.css`. Todo texto del inventario se escapa antes de insertarse como HTML, y las zonas de los equipos se validan contra la lista conocida.
- `.env`, `data/` y `certs/` están en `.gitignore`: si el repo se publica en GitHub, no los agregues con `git add -f`.
- Los video walls (Optiplex) a veces tardan más de 20 s en entregar el cuadro y fallan una ronda; se recuperan en la siguiente.

## Pruebas sin la VLAN

Pruebas automáticas (filtro RFB, registro de control, puente en solo lectura, límites de parser y de uso):

```
npm test
```

`test/fake-vnc-server.js` simula equipos VNC (cada 127.0.0.x responde como un equipo distinto):

```
node --openssl-legacy-provider test/fake-vnc-server.js 5901 claveprueba
```

En otra terminal (PowerShell):

```
$env:VNC_PORT='5901'; $env:VNC_PASSWORD='claveprueba'; $env:INVENTORY_FILE='test/inventory.test.json'; $env:PORT='8099'; npm start
```

El login de prueba usa la misma contraseña configurada con `npm run set-password`. Si fijaste `APP_HOSTS`/`APP_ORIGINS` para el puerto 8080, agrega también `127.0.0.1:8099` o usa el puerto normal.
