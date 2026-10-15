# Monitoreo de obras

App para **seguimiento de obras desde el celular**, conectada a un servidor que corre en **tu computadora**.
Es una PWA: se abre en el navegador del teléfono y se puede instalar como app (Android/iPhone), sin tiendas.

## Qué hace

- **Obras** con semáforo de avance (físico vs. planificado por tiempo), financiero y desviación.
- **Partidas/presupuesto** (importables pegando desde Excel) y **registro de avance** por partida.
- **Fotos** con fecha, hora y GPS estampados (cámara o galería), ligadas a avances e incidencias.
- **Bitácora e incidencias** (nota, visita, incidencia con severidad; abrir/cerrar).
- **Pagos / valorizaciones** → avance financiero.
- **Informes**: HTML imprimible (Guardar como PDF) y **Excel (.xlsx)** por rango de fechas.
- **Sin conexión**: lo que registres sin señal se guarda en el teléfono y se envía solo al volver internet.
- **Usuarios y roles**: `admin`, `supervisor`, `residente`, `lector`; cada persona ve solo las obras asignadas.

## Requisitos y arranque

Solo **Node.js 22.13 o superior**. No hay dependencias que instalar.

```bash
npm start            # http://localhost:3000
```

La primera vez, abre la app y crea la cuenta de administrador. La terminal muestra también la dirección
para el celular (ej. `http://192.168.1.20:3000`). Variables opcionales: `PORT`, `HOST`, `DATA_DIR`.

Datos: `data/obras.db` (SQLite) y `data/uploads/` (fotos). **Respáldalos copiando la carpeta `data/`.**

## Conectar el celular

**Windows:** doble clic en `iniciar.bat` (misma WiFi) o `iniciar-con-internet.bat` (túnel Cloudflare, datos móviles).

### A) Misma red WiFi (lo más simple)
Abre en el celular la dirección que imprime `npm start`. Puede que debas permitir Node en el firewall de la PC.

> **Importante:** los navegadores móviles solo dan **GPS, instalación como app y modo sin conexión** en
> páginas **HTTPS**. Por HTTP plano la app funciona (fotos, registros), pero sin GPS ni instalación.

Para tener HTTPS en la red local:
1. **Recomendado:** [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, luego
   `mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 TU-IP`,
   e instala la CA de mkcert en el teléfono. Reinicia `npm start`.
2. Rápido pero con aviso del navegador: `scripts/gen-cert.sh` (certificado autofirmado).
   El GPS suele funcionar tras aceptar el aviso, pero el navegador puede negarse a instalar la app/modo offline.

El servidor usa HTTPS automáticamente si existen `certs/key.pem` y `certs/cert.pem`.

### B) Desde internet (obra con datos móviles)
Un túnel da HTTPS válido sin abrir puertos del router, p. ej. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel --url http://localhost:3000     # URL temporal https://xxxx.trycloudflare.com
```
Con un túnel permanente y dominio propio, ejecuta el servidor con `BEHIND_HTTPS=1` (cookie `Secure`).
La PC debe estar encendida. Si prefieres no depender de ella, puedes desplegar la misma carpeta en un VPS.

### C) Sin conexión
Funciona sola: la app guarda lecturas ya visitadas y una **cola de envíos** (⏳ arriba a la derecha). Para
tener la obra disponible sin señal, ábrela una vez con internet antes de ir a campo.

## Roles

| Rol | Puede |
|---|---|
| admin | Todo: usuarios, asignar personas a obras, todas las obras |
| supervisor | Crear/editar obras asignadas, partidas, pagos, borrar registros |
| residente | Registrar avances, bitácora y fotos en sus obras |
| lector | Solo ver |

## Seguridad
Contraseñas con scrypt, sesión por cookie firmada (HttpOnly, 30 días), límite de intentos de login, cabeceras CSP,
fotos solo para miembros de la obra, entradas validadas. Usa HTTPS si expones la app a internet.

## Escalar
SQLite aguanta bien decenas de obras y usuarios. Si crece mucho, el acceso a datos está concentrado en
`server/index.js` y `server/db.js` para migrar a PostgreSQL.

## Desarrollo
```bash
npm test         # pruebas de API (node:test)
npm run icons    # regenerar iconos PWA
npm run dev      # reinicio automático
```
