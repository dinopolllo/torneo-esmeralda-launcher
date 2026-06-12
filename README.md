# Launcher — Torneo Esmeralda

Launcher Electron para Windows que envuelve mGBA, lanza Pokémon Esmeralda y sincroniza el `.sav` automáticamente con el backend del torneo.

## Estructura

```
launcher/
├── package.json                  ← Config Electron + electron-builder
├── src/
│   ├── main.js                   ← Proceso principal (IPC, watcher, mGBA)
│   ├── preload.js                ← Puente seguro main ↔ renderer
│   └── renderer.html             ← UI (estética GBA retro)
├── resources/
│   ├── icon.ico                  ← Ícono para Windows (256×256, tú lo provees)
│   └── icon.png                  ← Ícono para la ventana
├── emulator/                     ← ← TÚ AGREGAS mGBA AQUÍ
│   └── mGBA.exe                  ← Descarga: https://mgba.io/downloads.html
├── rom/                          ← ← TÚ AGREGAS LA ROM AQUÍ
│   └── Pokemon Emerald.gba
└── saves/                        ← Se crea solo al primer .sav
```

## Setup inicial

### 1. Instalar dependencias

Requiere Node.js 18+.

```bash
cd launcher
npm install
```

### 2. Agregar mGBA portable

Descarga mGBA portable para Windows desde https://mgba.io/downloads.html y descomprime el contenido (mGBA.exe + dlls) dentro de `launcher/emulator/`.

La estructura debe quedar:
```
emulator/
├── mGBA.exe
├── libgcc_s_seh-1.dll
├── (y demás DLLs)
```

### 3. Agregar la ROM

Coloca tu ROM de Pokémon Esmeralda como `launcher/rom/Pokemon Emerald.gba` (o cualquier nombre `.gba`).

### 4. (Opcional) Agregar íconos

- `resources/icon.ico` — 256×256, formato ICO
- `resources/icon.png` — 256×256, formato PNG

Si no los provees, se usará el ícono por defecto de Electron.

## Probar en desarrollo

```bash
npm start
```

Esto abre el launcher conectado al backend que configures (por defecto `http://localhost:8000`).

## Compilar para distribución

```bash
npm run build:portable
```

Esto genera un único `.exe` portable en `dist/TorneoEsmeralda-1.0.0.exe`. Tu jugador solo descarga ese archivo + descomprime la carpeta `emulator/` y `rom/` que vienen junto a él, hace doble clic y listo.

## Cómo se distribuye al jugador

Después de `build:portable`, empaqueta en un `.zip` con esta estructura:

```
TorneoEsmeralda/
├── TorneoEsmeralda-1.0.0.exe
├── emulator/           ← Copiar la carpeta emulator/ original
│   └── mGBA.exe + dlls
└── rom/                ← Copiar la carpeta rom/ original
    └── Pokemon Emerald.gba
```

El jugador descomprime el `.zip`, hace doble clic en `.exe`, ingresa la URL del backend + su username una sola vez, y ya queda configurado.

## Flujo de uso (lado del jugador)

1. **Primera vez:** abre el `.exe` → ingresa URL del backend, URL de la webapp y su username → "Entrar al Torneo"
2. **A partir de ahí:** abre el launcher → ve su progreso (badges, PV) → presiona "▶ Jugar Pokémon Esmeralda" → se abre mGBA con la ROM
3. **Mientras juega:** cada vez que guarda en el juego (con SAVE en el menú), mGBA escribe el `.sav` y el launcher lo detecta en ~2 segundos y lo sube al backend
4. **Ver actividad:** botón "🌐 Abrir Webapp" abre el navegador con la sesión ya iniciada (token en URL)

## Funcionamiento técnico

- **Watcher:** `chokidar` vigila `saves/Pokemon Emerald.sav` con debounce de 2s
- **Subida:** POST multipart al backend `/save/upload` con el header `Authorization: Bearer <token>`
- **Config persistente:** `config.json` junto al `.exe` (no en AppData, para que sea portable)
- **mGBA:** se lanza con `--savegame <ruta>` para forzar el path del `.sav` a la carpeta `saves/`

## Variables modificables en `main.js`

- `DEFAULT_API` — URL del backend por defecto en login
- `DEFAULT_WEBAPP` — URL de la webapp por defecto en login

## Solución de problemas

- **"mGBA no encontrado":** revisa que `emulator/mGBA.exe` exista
- **"ROM no encontrada":** revisa que haya un archivo `.gba` en `rom/`
- **"Sin conexión al backend":** verifica que la URL del backend en config sea accesible desde el equipo del jugador
- **El .sav no se sube:** verifica que el jugador haya guardado dentro del juego (no basta con cerrar mGBA)
