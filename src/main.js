/**
 * main.js — Proceso principal de Electron
 * ========================================
 *  - Crea la ventana del launcher
 *  - Lanza mGBA con la ROM como subproceso
 *  - Vigila el archivo .sav y lo sube al backend cuando cambia
 *  - Gestiona la configuración (token, username) en disco
 *  - Expone IPC para que la UI dispare acciones
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const chokidar = require('chokidar');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { autoUpdater } = require('electron-updater');

// ─── Logging a archivo ───────────────────────────────────────────────────────
const LOG_PATH = path.join(app.getPath('userData'), 'launcher.log');
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);
function writeLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
}
console.log   = (...a) => { _origLog(...a);   writeLog('INFO',  a); };
console.error = (...a) => { _origError(...a); writeLog('ERROR', a); };
console.warn  = (...a) => { _origWarn(...a);  writeLog('WARN',  a); };

// ─── Configuración ───────────────────────────────────────────────────────────

// Rutas: en producción, los recursos están en process.resourcesPath
const isPackaged = app.isPackaged;

const DEFAULT_API = 'https://camisole-sterling-unpadded.ngrok-free.dev';
const DEFAULT_WEBAPP = isPackaged
  ? `file://${path.join(process.resourcesPath, 'webapp', 'index.html')}`
  : `file://${path.resolve(__dirname, '../../webapp/index.html')}`;
const RESOURCES_DIR = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..');

const EMULATOR_DIR = path.join(RESOURCES_DIR, 'emulator');
const ROM_DIR      = path.join(RESOURCES_DIR, 'rom');
const SCRIPT_DIR     = path.join(RESOURCES_DIR, 'script');
const TRACKER_SCRIPT = path.join(SCRIPT_DIR, 'emerald_tracker.lua');

// Saves y config van a AppData en producción (estable aunque sea portable)
const USER_DATA_DIR = isPackaged
  ? app.getPath('userData')
  : path.join(__dirname, '..');

const SAVES_DIR    = path.join(USER_DATA_DIR, 'saves');
const CONFIG_PATH  = path.join(USER_DATA_DIR, 'config.json');

// Asegurar que las carpetas existen
if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });

// ─── Estado global ───────────────────────────────────────────────────────────

let mainWindow       = null;
let emulatorProcess  = null;
let savWatcher       = null;
let gameEventServer  = null;
let uploadInProgress = false;
let uploadDebounceTimer = null;

// Estado para detección de eventos desde .sav
let lastBadgeByte = -1; // -1 = no inicializado
let lastPartyHP   = null;


// ─── Configuración persistente ───────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Error leyendo config:', e);
  }
  return {
    apiUrl: DEFAULT_API,
    webappUrl: DEFAULT_WEBAPP,
    username: null,
    token: null,
    starter_seed: null,
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Error guardando config:', e);
    return false;
  }
}


// ─── Detectar archivos necesarios ────────────────────────────────────────────

function findRom() {
  if (!fs.existsSync(ROM_DIR)) return null;
  // Prefer the per-player patched ROM; never use the base ROM for playing
  if (fs.existsSync(path.join(ROM_DIR, 'Pokemon Emerald.gba'))) return 'Pokemon Emerald.gba';
  const files = fs.readdirSync(ROM_DIR);
  return files.find(f => /\.(gba|zip)$/i.test(f) && f !== 'Pokemon Emerald Base.gba') || null;
}

function findEmulator() {
  const platform = process.platform;
  const candidates = platform === 'win32'
    ? ['mGBA.exe', 'mgba.exe']
    : platform === 'darwin'
      ? ['mGBA.app/Contents/MacOS/mGBA', 'mgba']
      : ['mgba-qt', 'mgba'];

  // Buscar primero en el directorio bundleado
  if (fs.existsSync(EMULATOR_DIR)) {
    for (const c of candidates) {
      const full = path.join(EMULATOR_DIR, c);
      if (fs.existsSync(full)) return full;
    }
  }

  // En dev mode en Linux: usar el mGBA instalado en el sistema
  if (!isPackaged && platform === 'linux') {
    const { execSync } = require('child_process');
    for (const c of candidates) {
      try {
        const found = execSync(`which ${c} 2>/dev/null`).toString().trim();
        if (found) return found;
      } catch (_) {}
    }
  }

  return null;
}

function getSavPath() {
  const rom = findRom();
  if (!rom) return null;
  const base = path.parse(rom).name;
  // mGBA a veces ignora dirs.save y guarda junto a la ROM — detectar ambas rutas
  const savInRom   = path.join(ROM_DIR,   `${base}.sav`);
  const savInSaves = path.join(SAVES_DIR, `${base}.sav`);
  return fs.existsSync(savInRom) ? savInRom : savInSaves;
}

function getAllSavPaths() {
  const rom = findRom();
  if (!rom) return [];
  const base = path.parse(rom).name;
  return [
    path.join(ROM_DIR,   `${base}.sav`),
    path.join(SAVES_DIR, `${base}.sav`),
  ];
}


// ─── Randomización de starters por jugador ───────────────────────────────────

// Solo Pokémon que son la PRIMERA etapa de su línea evolutiva (sin pre-evolución
// en Gen I-III) Y que tienen al menos una evolución en Gen I-III. Sin legendarios.
const ELIGIBLE_STARTER_IDS = [
  // Gen I (internal = NatDex)
  1,4,7,10,13,16,19,21,23,27,29,32,37,41,43,46,48,50,52,54,56,58,60,63,66,69,
  72,74,77,79,81,84,86,88,90,92,96,98,100,102,104,109,111,113,116,118,120,123,
  129,133,138,140,147,
  // Gen II (internal = NatDex)
  152,155,158,161,163,165,167,170,172,173,174,175,177,179,187,194,204,209,216,
  218,220,223,228,231,236,238,239,240,246,
  // Gen III (internal = NatDex + 25)
  277,280,283,286,288,290,295,298,301,303,305,308,310,312,315,318,321,323,325,
  329,332,334,341,343,345,350,353,356,358,364,366,368,370,372,378,380,386,388,
  396,399,
];

function seededSample(pool, n, seed) {
  // Mulberry32 PRNG + Fisher-Yates shuffle
  let s = (seed + 1) >>> 0;
  function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  }
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

async function patchRomForPlayer(seed) {
  const baseRomPath = path.join(ROM_DIR, 'Pokemon Emerald Base.gba');
  const outRomPath  = path.join(ROM_DIR, 'Pokemon Emerald.gba');

  if (!fs.existsSync(baseRomPath)) {
    console.error('[rom] ROM base no encontrada:', baseRomPath);
    return false;
  }

  const rom = Buffer.from(fs.readFileSync(baseRomPath));
  const chosen = seededSample(ELIGIBLE_STARTER_IDS, 3, seed);

  // Parchear array de starters: buscar patrón Treecko(277) Torchic(280) Mudkip(283)
  const ORIG_PATTERN = Buffer.from([0x15,0x01, 0x18,0x01, 0x1B,0x01]);
  const arrOff = rom.indexOf(ORIG_PATTERN);
  if (arrOff === -1) {
    console.error('[rom] No se encontró el patrón de starters — ¿el ROM base es correcto?');
    return false;
  }
  rom.writeUInt16LE(chosen[0], arrOff);
  rom.writeUInt16LE(chosen[1], arrOff + 2);
  rom.writeUInt16LE(chosen[2], arrOff + 4);

  // Parchear entradas del rival (nivel 5, species original del starter)
  const ORIG_STARTERS = [277, 280, 283];
  const lo = 0x280000;
  const hi = Math.min(0x400000, rom.length);

  for (let i = 0; i < 3; i++) {
    const origSp = ORIG_STARTERS[i];
    const newSp  = chosen[i];
    const lv5Entry = Buffer.alloc(4);
    lv5Entry.writeUInt16LE(5, 0);
    lv5Entry.writeUInt16LE(origSp, 2);

    let start = lo;
    while (start < hi) {
      const idx = rom.indexOf(lv5Entry, start);
      if (idx === -1 || idx >= hi) break;
      if (idx >= 4 && rom.readUInt32LE(idx - 4) === 0) {
        rom.writeUInt16LE(newSp, idx + 2);
      }
      start = idx + 1;
    }
  }

  // Precios x4 en gItems (tiendas in-game)
  patchItemPrices(rom, 4);

  fs.mkdirSync(ROM_DIR, { recursive: true });
  fs.writeFileSync(outRomPath, rom);
  console.log(`[rom] Parcheado con seed ${seed}: starters internos [${chosen.join(', ')}]`);
  return true;
}

// ─── Patch de precios in-game ────────────────────────────────────────────────
// gItems en Pokémon Emerald (BPEE 1.0) está en 0x5839A0.
// 377 entradas × 44 bytes. Cada entrada: name[14] + itemId(u16) + price(u16) + ...
// Solo modificamos entradas donde itemId == índice (entrada real) y price > 0
// (excluye placeholders + key items / regalos no comprables).
const G_ITEMS_OFFSET = 0x5839A0;
const G_ITEMS_COUNT  = 377;
const ITEM_ENTRY_SIZE = 44;
const ITEM_PRICE_OFF  = 16;   // dentro de la entrada

function patchItemPrices(rom, mult) {
  // Verificar firma del array: los primeros 6 items tienen itemId == índice
  for (let i = 0; i < 6; i++) {
    const id = rom.readUInt16LE(G_ITEMS_OFFSET + i * ITEM_ENTRY_SIZE + 14);
    if (id !== i) {
      console.warn(`[rom] gItems no coincide en índice ${i} (id=${id}). Salto patch de precios.`);
      return 0;
    }
  }
  let touched = 0, saturated = 0;
  for (let i = 0; i < G_ITEMS_COUNT; i++) {
    const off  = G_ITEMS_OFFSET + i * ITEM_ENTRY_SIZE;
    const id   = rom.readUInt16LE(off + 14);
    const oldP = rom.readUInt16LE(off + ITEM_PRICE_OFF);
    if (id !== i || oldP === 0) continue;     // skip placeholders / no-comprable
    let newP = oldP * mult;
    if (newP > 0xFFFF) { newP = 0xFFFF; saturated++; }
    rom.writeUInt16LE(newP, off + ITEM_PRICE_OFF);
    touched++;
  }
  console.log(`[rom] Precios in-game ×${mult}: ${touched} items actualizados (${saturated} saturados a 65535)`);
  return touched;
}


// ─── Parser de eventos desde el archivo .sav ─────────────────────────────────
// Detecta medallas y faints leyendo el .sav directamente, sin depender del
// script Lua. Es el mecanismo principal; el script Lua añade detección en tiempo real.

const SAVE_MAGIC = 0x08012025; // firma de sección válida en Gen III

function findSaveSection(buf, targetId) {
  // Footer layout: id(2)@FF4, ck(2)@FF6, sig(4)@FF8, idx(4)@FFC
  let bestIdx = -1, bestOff = -1;
  for (let sec = 0; sec < 32; sec++) {
    const off = sec * 0x1000;
    if (off + 0x1000 > buf.length) break;
    if (buf.readUInt32LE(off + 0xFF8) !== SAVE_MAGIC) continue;
    if (buf.readUInt16LE(off + 0xFF4) !== targetId) continue;
    const idx = buf.readUInt32LE(off + 0xFFC);
    if (idx > bestIdx) { bestIdx = idx; bestOff = off; }
  }
  return bestOff; // -1 si no se encontró
}

function initSavState(savPath) {
  try {
    const buf = fs.readFileSync(savPath);
    const s0 = findSaveSection(buf, 0);
    if (s0 >= 0) lastBadgeByte = buf[s0 + 0x1F];
    const s1 = findSaveSection(buf, 1);
    if (s1 >= 0) {
      lastPartyHP = [];
      for (let i = 0; i < 6; i++) {
        const base = s1 + 0x238 + i * 0x64;
        lastPartyHP.push({
          hp:    buf.readUInt16LE(base + 0x56),
          max:   buf.readUInt16LE(base + 0x58),
          level: buf[base + 0x54],
        });
      }
    }
    console.log(`[sav] Estado inicial cargado: badges=0x${(lastBadgeByte || 0).toString(16).padStart(2,'0')}`);
  } catch (e) {
    console.warn('[sav] No se pudo leer estado inicial:', e.message);
  }
}

async function checkSavEvents(savPath) {
  const config = loadConfig();
  if (!config.token) return;
  let buf;
  try { buf = fs.readFileSync(savPath); } catch { return; }

  // ── Medallas: sección 0 (SaveBlock2), byte 0x1F ───────────────────────────
  const s0 = findSaveSection(buf, 0);
  if (s0 >= 0) {
    const badges = buf[s0 + 0x1F];
    if (lastBadgeByte < 0) {
      lastBadgeByte = badges;
    } else {
      for (let i = 0; i < 8; i++) {
        if ((badges & (1 << i)) && !(lastBadgeByte & (1 << i))) {
          console.log(`[sav] Medalla ${i} detectada desde .sav`);
          forwardGameEvent({ type: 'badge_earned', badge_index: i });
        }
      }
      lastBadgeByte = badges;
    }
  }

  // ── Faints: sección 1 (SaveBlock1), party @ 0x238, HP @ +0x56 ────────────
  const s1 = findSaveSection(buf, 1);
  if (s1 >= 0) {
    const partyCount = buf[s1 + 0x234];
    const current = [];
    for (let i = 0; i < 6; i++) {
      const base = s1 + 0x238 + i * 0x64;
      current.push({
        hp:    buf.readUInt16LE(base + 0x56),
        max:   buf.readUInt16LE(base + 0x58),
        level: buf[base + 0x54],
      });
    }
    if (lastPartyHP !== null) {
      for (let i = 0; i < partyCount; i++) {
        const prev = lastPartyHP[i];
        const curr = current[i];
        if (curr.max > 0 && curr.hp === 0 && prev.hp > 0) {
          console.log(`[sav] Faint slot ${i} nivel ${curr.level} detectado desde .sav`);
          // species_id no requerido: el backend lo resuelve desde el snapshot subido
          forwardGameEvent({ type: 'pokemon_fainted', slot: i, level: curr.level });
        }
      }
    }
    lastPartyHP = current;
  }
}


// ─── Servidor TCP para eventos en tiempo real del script mGBA ────────────────

const TRACKER_PORT = 8765;

// Socket activo del Lua tracker (para enviarle recompensas)
let activeTrackerSocket = null;
// Reward IDs en vuelo (esperando ACK) → {kind, dbId}
const inflightRewards = new Map();
let rewardPollTimer = null;

function startGameEventServer() {
  if (gameEventServer) return;

  gameEventServer = net.createServer((sock) => {
    activeTrackerSocket = sock;
    console.log('[tracker] Conexión Lua establecida — listo para enviar recompensas');

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.type === 'reward_ack') {
            handleRewardAck(evt);
          } else if (evt.type === 'pong') {
            // keepalive
          } else {
            console.log('[tracker] Evento recibido por TCP:', trimmed);
            forwardGameEvent(evt);
          }
        } catch (e) {
          console.error('[tracker] JSON inválido recibido:', trimmed);
        }
      }
    });
    sock.on('close', () => {
      if (activeTrackerSocket === sock) activeTrackerSocket = null;
      console.log('[tracker] Conexión Lua cerrada');
    });
    sock.on('error', () => {
      if (activeTrackerSocket === sock) activeTrackerSocket = null;
    });
  });

  gameEventServer.listen(TRACKER_PORT, '127.0.0.1', () => {
    console.log(`[tracker] Servidor de eventos escuchando en puerto ${TRACKER_PORT}`);
  });

  gameEventServer.on('error', (e) => {
    console.error('[tracker] Error en servidor TCP:', e.message);
  });

  // Iniciar el poll de recompensas pendientes
  startRewardPoll();
}

// ─── Entrega de recompensas in-game ──────────────────────────────────────────

function startRewardPoll() {
  if (rewardPollTimer) clearInterval(rewardPollTimer);
  rewardPollTimer = setInterval(pollPendingRewards, 5_000);
  setTimeout(pollPendingRewards, 1_500);
  console.log('[rewards] Poll de recompensas iniciado (cada 5s)');
}

function sendToTracker(payload) {
  if (!activeTrackerSocket) return false;
  try {
    activeTrackerSocket.write(JSON.stringify(payload) + '\n');
    return true;
  } catch (e) {
    console.error('[rewards] No se pudo escribir al socket Lua:', e.message);
    return false;
  }
}

async function pollPendingRewards() {
  const config = loadConfig();
  if (!config.token) {
    console.log('[rewards] sin token — skip poll');
    return;
  }
  if (!activeTrackerSocket) {
    // Solo loguear cuando hay rewards pendientes para no spamear
    try {
      const res = await fetch(`${config.apiUrl}/rewards/pending`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      if (res.ok) {
        const body = await res.json();
        const pendingCount = (body?.data?.items?.length || 0) + (body?.data?.pokemon?.length || 0);
        if (pendingCount > 0) {
          console.log(`[rewards] ${pendingCount} recompensas pendientes, pero el tracker Lua no está conectado (carga el script en mGBA)`);
        }
      }
    } catch {}
    return;
  }

  try {
    const res = await fetch(`${config.apiUrl}/rewards/pending`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) {
      console.warn('[rewards] /rewards/pending devolvió', res.status);
      return;
    }
    const body = await res.json();
    const items = body?.data?.items || [];
    const pokemon = body?.data?.pokemon || [];

    if (items.length === 0 && pokemon.length === 0) return;
    console.log(`[rewards] pending: ${items.length} items + ${pokemon.length} pokémon`);

    for (const it of items) {
      if (inflightRewards.has(`item:${it.id}`)) continue;
      const sent = sendToTracker({
        type: 'give_item',
        reward_id: it.id,
        slug: it.slug,
        qty: it.qty,
      });
      if (sent) {
        inflightRewards.set(`item:${it.id}`, { kind: 'item', dbId: it.id });
        console.log(`[rewards] → Lua: item id=${it.id} ${it.slug} ×${it.qty}`);
        notifyUI('rewards:sent', { kind: 'item', slug: it.slug, qty: it.qty });
      } else {
        console.warn(`[rewards] no se pudo enviar item ${it.id} (socket cerrado?)`);
      }
    }
    for (const p of pokemon) {
      if (inflightRewards.has(`pokemon:${p.id}`)) continue;
      const sent = sendToTracker({
        type: 'give_pokemon',
        reward_id: p.id,
        pokemon_id: p.pokemon_id,
        name: p.name,
        is_shiny: !!p.is_shiny,
      });
      if (sent) {
        inflightRewards.set(`pokemon:${p.id}`, { kind: 'pokemon', dbId: p.id });
        console.log(`[rewards] → Lua: pokemon id=${p.id} #${p.pokemon_id} ${p.name}${p.is_shiny ? ' SHINY' : ''}`);
        notifyUI('rewards:sent', { kind: 'pokemon', name: p.name });
      }
    }
  } catch (e) {
    console.error('[rewards] poll error:', e.message);
  }
}

async function handleRewardAck(evt) {
  const key = `${evt.kind}:${evt.reward_id}`;
  const entry = inflightRewards.get(key);
  if (!entry) {
    console.warn(`[rewards] ACK sin inflight para ${key}`);
    return;
  }
  inflightRewards.delete(key);

  if (!evt.ok) {
    const reason = evt.reason ? ` (${evt.reason})` : '';
    console.warn(`[rewards] Lua reportó FALLO para ${key}${reason} — reintento en siguiente poll`);
    return;
  }

  console.log(`[rewards] ✓ ${key} entregado in-game, marcando claim`);
  const config = loadConfig();
  if (!config.token) return;
  const body = entry.kind === 'item'
    ? { item_ids: [entry.dbId], pokemon_ids: [] }
    : { item_ids: [], pokemon_ids: [entry.dbId] };
  try {
    const res = await fetch(`${config.apiUrl}/rewards/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[rewards] /rewards/claim devolvió ${res.status}`);
    notifyUI('rewards:delivered', { kind: entry.kind, dbId: entry.dbId });
  } catch (e) {
    console.error('[rewards] No se pudo marcar entregado:', e.message);
  }
}

async function forwardGameEvent(evt) {
  const config = loadConfig();
  if (!config.token) {
    console.log('[tracker] Sin token — evento descartado:', evt.type);
    return;
  }
  try {
    const res = await fetch(`${config.apiUrl}/internal/game-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(evt),
    });
    const body = await res.json();
    if (res.ok && body.data?.processed) {
      console.log('[tracker] Evento procesado en backend:', evt.type, body.data);
      notifyUI('tracker:event', { ...evt, ...body.data });
    }
  } catch (e) {
    console.error('[tracker] Error enviando al backend:', e.message);
  }
}

// Registra el script en el config de mGBA para que se cargue automáticamente
function injectTrackerIntoMgbaConfig() {
  if (!fs.existsSync(TRACKER_SCRIPT)) return;

  // Si existe portable.ini junto al ejecutable de mGBA, el config vive ahí mismo
  // (modo portable). Si no, va al directorio de config del usuario.
  const portableIni = path.join(EMULATOR_DIR, 'portable.ini');
  let configDir;
  if (fs.existsSync(portableIni)) {
    configDir = EMULATOR_DIR;
  } else {
    configDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'mGBA')
      : path.join(os.homedir(), '.config', 'mgba');
  }

  const qtIni = path.join(configDir, 'qt.ini');
  const trackerPath = TRACKER_SCRIPT.replace(/\\/g, '/');

  try {
    // Crear qt.ini si no existe (primera ejecución en modo portable)
    let ini = fs.existsSync(qtIni) ? fs.readFileSync(qtIni, 'utf-8') : '';

    if (ini.includes(trackerPath)) return; // ya está registrado

    const scriptEntry = `scripts\\1\\path=${trackerPath}\nscripts\\size=1`;
    if (!ini.includes('[scripting]')) {
      ini += `\n[scripting]\n${scriptEntry}\n`;
    } else {
      ini = ini.replace(/\[scripting\][^\[]*/s, `[scripting]\n${scriptEntry}\n`);
    }
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(qtIni, ini, 'utf-8');
    console.log('[tracker] Script registrado en qt.ini:', qtIni);
  } catch (e) {
    console.warn('[tracker] No se pudo escribir qt.ini:', e.message);
  }
}

let _scriptFlagCache = null;
function checkScriptFlag(emuPath) {
  if (_scriptFlagCache !== null) return _scriptFlagCache;
  try {
    const result = spawnSync(emuPath, ['--help'], { encoding: 'utf-8', timeout: 3000 });
    const out = (result.stdout || '') + (result.stderr || '');
    _scriptFlagCache = out.includes('--script');
  } catch {
    _scriptFlagCache = false;
  }
  console.log(`[tracker] --script soportado: ${_scriptFlagCache}`);
  return _scriptFlagCache;
}

// ─── Lanzar mGBA ─────────────────────────────────────────────────────────────

// Si la ROM parcheada falta (puede pasar tras un auto-update que reemplaza
// la carpeta resources/) pero tenemos un starter_seed en config, regeneramos
// la ROM personalizada desde Pokemon Emerald Base.gba antes de lanzar.
async function ensureRomPatched() {
  const patchedPath = path.join(ROM_DIR, 'Pokemon Emerald.gba');
  if (fs.existsSync(patchedPath)) return true;
  const config = loadConfig();
  if (!config.starter_seed) return false;
  console.log('[rom] ROM parcheada ausente — regenerando con seed', config.starter_seed);
  return await patchRomForPlayer(config.starter_seed);
}

// Copia el .sav a SAVES_DIR (AppData) como backup. SAVES_DIR persiste entre
// updates, ROM_DIR no. Se llama tras cada cambio detectado del .sav.
function mirrorSavToBackup(savPath) {
  try {
    if (!savPath || !fs.existsSync(savPath)) return;
    const fileName = path.basename(savPath);
    const backupPath = path.join(SAVES_DIR, fileName);
    if (path.resolve(savPath) === path.resolve(backupPath)) return;  // ya está en backup
    fs.mkdirSync(SAVES_DIR, { recursive: true });
    fs.copyFileSync(savPath, backupPath);
    console.log(`[sav] Backup espejado en AppData: ${backupPath}`);
  } catch (e) {
    console.warn('[sav] No se pudo espejar backup:', e.message);
  }
}

// Si ROM_DIR no tiene .sav pero SAVES_DIR sí, restaurarlo. Crítico tras un
// auto-update que limpia resources/.
function restoreSavFromBackup() {
  try {
    const rom = findRom();
    if (!rom) return;
    const base = path.parse(rom).name;
    const inRom    = path.join(ROM_DIR,   `${base}.sav`);
    const inBackup = path.join(SAVES_DIR, `${base}.sav`);
    if (fs.existsSync(inRom)) return;
    if (!fs.existsSync(inBackup)) return;
    fs.copyFileSync(inBackup, inRom);
    console.log(`[sav] Progreso restaurado desde AppData: ${inBackup} → ${inRom}`);
  } catch (e) {
    console.warn('[sav] No se pudo restaurar backup:', e.message);
  }
}

// Si NINGUNA copia local existe pero hay backup remoto en el backend, lo
// descarga. Última red de seguridad — ej. usuario formateó la PC.
async function restoreSavFromServer() {
  const config = loadConfig();
  if (!config.token) return false;
  const rom = findRom();
  if (!rom) return false;
  const base = path.parse(rom).name;
  const inRom    = path.join(ROM_DIR,   `${base}.sav`);
  const inBackup = path.join(SAVES_DIR, `${base}.sav`);
  if (fs.existsSync(inRom) || fs.existsSync(inBackup)) return false;

  try {
    const info = await fetch(`${config.apiUrl}/save/info`, {
      headers: { Authorization: `Bearer ${config.token}` },
    }).then(r => r.json());
    if (!info?.data?.exists) {
      console.log('[sav] Sin backup remoto disponible');
      return false;
    }
    console.log(`[sav] Descargando backup remoto (${info.data.size} B, ${info.data.modified_at})`);
    const res = await fetch(`${config.apiUrl}/save/download`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) {
      console.warn('[sav] Fallo descarga remota:', res.status);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(SAVES_DIR, { recursive: true });
    fs.writeFileSync(inRom, buf);
    fs.writeFileSync(inBackup, buf);
    console.log(`[sav] Progreso restaurado desde el servidor a ${inRom}`);
    notifyUI('sav:restored', { source: 'server', size: buf.length });
    return true;
  } catch (e) {
    console.warn('[sav] Restore remoto falló:', e.message);
    return false;
  }
}

async function launchEmulator() {
  if (emulatorProcess) {
    return { ok: false, error: 'El emulador ya está corriendo' };
  }

  await ensureRomPatched();
  restoreSavFromBackup();

  const emuPath = findEmulator();
  const rom = findRom();

  if (!emuPath) {
    console.error(`mGBA no encontrado en: ${EMULATOR_DIR}`);
    return { ok: false, error: `mGBA no encontrado en: ${EMULATOR_DIR}` };
  }
  if (!rom) {
    console.error(`ROM no encontrada en: ${ROM_DIR}`);
    return { ok: false, error: `ROM no encontrada en: ${ROM_DIR}. Cierra sesión y vuelve a iniciar.` };
  }
  console.log(`Lanzando emulador: ${emuPath}`);

  const romPath = path.join(ROM_DIR, rom);

  // Inyectar script en qt.ini como fallback
  injectTrackerIntoMgbaConfig();

  const savesDir = SAVES_DIR.replace(/\\/g, '/');
  const scriptExists = fs.existsSync(TRACKER_SCRIPT);
  const scriptSupported = checkScriptFlag(emuPath);
  const args = [
    '-C', `dirs.save=${savesDir}`,
    ...(scriptExists && scriptSupported ? ['--script', TRACKER_SCRIPT] : []),
    romPath,
  ];

  try {
    emulatorProcess = spawn(emuPath, args, {
      detached: false,
      stdio: 'ignore',
    });

    emulatorProcess.on('exit', (code) => {
      console.log(`Emulador cerrado con código ${code}`);
      emulatorProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('emulator:stopped');
      }
    });

    emulatorProcess.on('error', (err) => {
      console.error('Error en emulador:', err);
      emulatorProcess = null;
    });

    return { ok: true, pid: emulatorProcess.pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stopEmulator() {
  if (!emulatorProcess) return { ok: false, error: 'Emulador no está corriendo' };
  try {
    emulatorProcess.kill();
    emulatorProcess = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


// ─── Watcher del .sav y subida al backend ────────────────────────────────────

function startSavWatcher() {
  const paths = getAllSavPaths();
  if (paths.length === 0) {
    console.log('No hay ROM, watcher no iniciado');
    return;
  }

  if (savWatcher) savWatcher.close();
  // Vigilar ambas rutas posibles: junto a la ROM y en SAVES_DIR
  savWatcher = chokidar.watch(paths, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    ignoreInitial: false,
  });

  savWatcher.on('add',    (filePath) => handleSavChange('add',    filePath));
  savWatcher.on('change', (filePath) => handleSavChange('change', filePath));

  // Inicializar estado desde .sav existente para no disparar eventos duplicados al arrancar
  const existing = paths.find(p => fs.existsSync(p));
  if (existing) initSavState(existing);

  console.log(`Watcher iniciado en: ${paths.join(' | ')}`);
}

function handleSavChange(reason, savPath) {
  console.log(`SAV ${reason}: ${savPath}`);

  // Espejar inmediatamente a SAVES_DIR (AppData) — sobrevive a auto-updates
  mirrorSavToBackup(savPath);

  // Debounce — esperar 2s tras el último cambio
  if (uploadDebounceTimer) clearTimeout(uploadDebounceTimer);
  uploadDebounceTimer = setTimeout(async () => {
    // Subir primero para que el snapshot del backend tenga datos frescos de party
    await uploadSav(savPath);
    // Luego detectar eventos (faint puede usar species del snapshot recién subido)
    await checkSavEvents(savPath);
  }, 2000);
}

async function uploadSav(savPath) {
  if (uploadInProgress) {
    console.log('Upload ya en progreso, saltando');
    return;
  }

  const config = loadConfig();
  if (!config.token) {
    console.log('Sin token, no se sube');
    notifyUI('upload:error', { error: 'No estás logueado' });
    return;
  }
  if (!fs.existsSync(savPath)) {
    console.log('SAV no existe aún');
    return;
  }

  uploadInProgress = true;
  notifyUI('upload:start', { path: savPath });

  try {
    const form = new FormData();
    form.append('save_file', fs.createReadStream(savPath), {
      filename: 'emerald.sav',
      contentType: 'application/octet-stream',
    });

    const res = await fetch(`${config.apiUrl}/save/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const body = await res.json();
    if (!res.ok) throw new Error(body?.detail?.error || `HTTP ${res.status}`);

    console.log('Upload OK:', body.data);
    notifyUI('upload:success', body.data);
  } catch (e) {
    console.error('Upload error:', e.message);
    notifyUI('upload:error', { error: e.message });
  } finally {
    uploadInProgress = false;
  }
}

function notifyUI(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}


// ─── IPC: comunicación con la UI ─────────────────────────────────────────────

ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (event, partial) => {
  const current = loadConfig();
  const next = { ...current, ...partial };
  saveConfig(next);
  return next;
});

ipcMain.handle('auth:login', async (event, username) => {
  const config = loadConfig();
  try {
    const form = new URLSearchParams();
    form.append('username', username);
    const res = await fetch(`${config.apiUrl}/auth/player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.detail?.error || 'Error de login');

    const newSeed = body.data.starter_seed;
    const romExists = fs.existsSync(path.join(ROM_DIR, 'Pokemon Emerald.gba'));
    if (newSeed && (newSeed !== config.starter_seed || !romExists)) {
      const patched = await patchRomForPlayer(newSeed);
      if (!patched) console.warn('[rom] Fallo al parchear ROM — el juego puede usar starters incorrectos');
    }

    saveConfig({ ...config, username: body.data.username, token: body.data.token, starter_seed: newSeed });
    startSavWatcher();
    return { ok: true, ...body.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:logout', () => {
  const config = loadConfig();
  saveConfig({ ...config, token: null, username: null });
  return { ok: true };
});

ipcMain.handle('emulator:launch', async () => await launchEmulator());
ipcMain.handle('emulator:stop', () => stopEmulator());
ipcMain.handle('emulator:status', () => ({
  running: emulatorProcess !== null,
  pid: emulatorProcess?.pid ?? null,
}));

ipcMain.handle('sav:upload-now', async () => {
  const savPath = getSavPath();
  if (!savPath || !fs.existsSync(savPath)) {
    return { ok: false, error: 'No hay archivo .sav todavía. Juega un poco primero.' };
  }
  await uploadSav(savPath);
  return { ok: true };
});

ipcMain.handle('webapp:open', () => {
  const config = loadConfig();
  if (!config.token) {
    return { ok: false, error: 'No estás logueado' };
  }
  const url = `${config.webappUrl}?token=${encodeURIComponent(config.token)}&api=${encodeURIComponent(config.apiUrl)}`;
  const webWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Torneo Esmeralda',
    autoHideMenuBar: true,
    backgroundColor: '#0a1f17',
    webPreferences: {
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  webWindow.loadURL(url);
  return { ok: true, url };
});

ipcMain.handle('system:check', () => {
  return {
    rom: findRom(),
    emulator: findEmulator(),
    savPath: getSavPath(),
    savExists: getSavPath() ? fs.existsSync(getSavPath()) : false,
  };
});

ipcMain.handle('system:info', () => ({
  resourcesDir: RESOURCES_DIR,
  emulatorDir: EMULATOR_DIR,
  romDir: ROM_DIR,
  savesDir: SAVES_DIR,
  configPath: CONFIG_PATH,
  logPath: LOG_PATH,
  isPackaged,
}));

ipcMain.handle('system:open-log', () => {
  shell.showItemInFolder(LOG_PATH);
});

ipcMain.handle('app:reset', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancelar', 'Sí, borrar todo'],
    defaultId: 0,
    cancelId: 0,
    title: 'Resetear datos',
    message: '¿Borrar todos los datos locales?',
    detail: 'Se eliminarán el save, la configuración y el log. El launcher se reiniciará limpio.\n\nEsto no afecta los datos del servidor.',
  });
  if (response !== 1) return { ok: false };

  // Detener emulador si corre
  if (emulatorProcess) { emulatorProcess.kill(); emulatorProcess = null; }
  if (savWatcher) { savWatcher.close(); savWatcher = null; }

  // Borrar saves (AppData y ROM_DIR por si mGBA ignoró dirs.save)
  for (const dir of [SAVES_DIR, ROM_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (/\.(sav|ss[0-9])$/i.test(f)) {
            fs.rmSync(path.join(dir, f), { force: true });
            console.log('Borrado:', path.join(dir, f));
          }
        }
      }
    } catch (e) { console.warn('Error borrando saves en', dir, ':', e.message); }
  }

  // Borrar ROM parcheado para que se regenere en el próximo login (no borrar el base)
  try {
    const patchedRom = path.join(ROM_DIR, 'Pokemon Emerald.gba');
    if (fs.existsSync(patchedRom)) {
      fs.rmSync(patchedRom, { force: true });
      console.log('ROM parcheado borrado:', patchedRom);
    }
  } catch (e) { console.warn('Error borrando ROM parcheado:', e.message); }

  // Resetear estado del parser de .sav
  lastBadgeByte = -1;
  lastPartyHP   = null;

  // Borrar config y log
  try { fs.rmSync(CONFIG_PATH, { force: true }); } catch (_) {}
  try { fs.rmSync(LOG_PATH, { force: true }); } catch (_) {}

  // Limpiar sección [scripting] del qt.ini de mGBA (portable)
  const qtIni = path.join(EMULATOR_DIR, 'qt.ini');
  try {
    if (fs.existsSync(qtIni)) {
      let ini = fs.readFileSync(qtIni, 'utf-8');
      ini = ini.replace(/\[scripting\][^\[]*/s, '');
      fs.writeFileSync(qtIni, ini, 'utf-8');
    }
  } catch (_) {}

  console.log('Datos reseteados — reiniciando launcher...');
  app.relaunch();
  app.exit(0);
  return { ok: true };
});


// ─── Ventana principal ───────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0a1f17',
    autoHideMenuBar: true,
    title: 'Torneo Esmeralda — Launcher',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  // F12 abre DevTools para debugging
  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Asegurar ROM + restaurar .sav (local primero, servidor como fallback)
  // ANTES del watcher para que la primera lectura del estado sea correcta
  (async () => {
    try {
      await ensureRomPatched();
      restoreSavFromBackup();
      await restoreSavFromServer();
    } catch (e) {
      console.warn('[init] restore fallback falló:', e.message);
    }
    startSavWatcher();
  })();
  startGameEventServer();
  // Chequear updates en cuanto la ventana esté lista (3s después)
  setTimeout(() => checkForUpdates(), 3_000);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (savWatcher) savWatcher.close();
    if (emulatorProcess) emulatorProcess.kill();
  });
}


// ─── Auto-update (GitHub Releases vía electron-updater) ──────────────────────
//
// El cliente consulta automáticamente latest.yml en el último release del repo
// configurado en package.json → build.publish. No requiere token: el .yml y el
// .exe se sirven directamente desde la URL pública del release.

autoUpdater.autoDownload = true;        // descargamos en background al detectar
autoUpdater.autoInstallOnAppQuit = true; // al cerrar la app, aplica el update

// Solo log a archivo + IPC al renderer (sin notificaciones nativas intrusivas)
autoUpdater.on('checking-for-update',  () => {
  console.log('[update] Buscando actualizaciones…');
  notifyUI('update:status', { state: 'checking' });
});
autoUpdater.on('update-not-available', (info) => {
  console.log('[update] Sin novedades (versión actual', info?.version, 'es la más reciente)');
  notifyUI('update:status', { state: 'none', version: info?.version });
});
autoUpdater.on('update-available', (info) => {
  console.log('[update] Nueva versión disponible:', info.version);
  notifyUI('update:status', { state: 'available', version: info.version });
});
autoUpdater.on('download-progress', (p) => {
  notifyUI('update:status', {
    state: 'downloading',
    percent: Math.round(p.percent),
    bytesPerSecond: p.bytesPerSecond,
  });
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('[update] Descargada, lista para instalar:', info.version);
  notifyUI('update:status', { state: 'ready', version: info.version });
});
autoUpdater.on('error', (e) => {
  console.error('[update] Error:', e.message);
  notifyUI('update:status', { state: 'error', error: e.message });
});

function checkForUpdates() {
  if (!app.isPackaged) {
    console.log('[update] Modo dev — skip check');
    return;
  }
  try {
    autoUpdater.checkForUpdates().catch(e => console.error('[update] check failed:', e.message));
  } catch (e) {
    console.error('[update] excepción al chequear:', e.message);
  }
}

// IPC: el usuario puede forzar un check o aplicar el update desde la UI
ipcMain.handle('update:check', () => { checkForUpdates(); return { ok: true }; });
ipcMain.handle('update:install', () => {
  console.log('[update] Aplicando ahora — reiniciando');
  autoUpdater.quitAndInstall();
  return { ok: true };
});
ipcMain.handle('update:get-version', () => ({ current: app.getVersion() }));


app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (savWatcher) savWatcher.close();
  if (gameEventServer) gameEventServer.close();
  if (emulatorProcess) emulatorProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
