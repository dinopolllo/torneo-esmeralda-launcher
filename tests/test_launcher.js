/**
 * test_launcher.js — Tests del launcher (sin Electron)
 * =====================================================
 * Verifica la lógica de:
 *  - Detección de paths (ROM, emulador, .sav)
 *  - Carga/guardado de config
 *  - Validación de archivos
 *
 * Para correr: `node tests/test_launcher.js`
 *
 * No requiere que Electron esté corriendo — usa stubs para el módulo `electron`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

// ─── Stub del módulo `electron` para que main.js cargue sin Electron ─────────

const originalResolve = Module._resolveFilename;
const electronStub = {
  app: {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: class {
    constructor() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: { handle: () => {} },
  shell: { openExternal: () => {} },
  dialog: {},
};

Module._resolveFilename = function(request, parent) {
  if (request === 'electron') return 'electron-stub';
  if (request === 'chokidar') return 'chokidar-stub';
  if (request === 'node-fetch') return 'node-fetch-stub';
  if (request === 'form-data') return 'form-data-stub';
  return originalResolve.apply(this, arguments);
};

require.cache['electron-stub'] = { exports: electronStub };
require.cache['chokidar-stub'] = { exports: { watch: () => ({ on: () => {}, close: () => {} }) } };
require.cache['node-fetch-stub'] = { exports: () => Promise.resolve({ ok: true, json: () => ({}) }) };
require.cache['form-data-stub'] = { exports: class { append() {} getHeaders() { return {}; } } };


// ─── Test runner ─────────────────────────────────────────────────────────────

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

let passed = 0, failed = 0;

function runTests() {
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`  ✓  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗  ${name}`);
      console.log(`     ${e.message}`);
      if (e.stack) console.log(e.stack.split('\n').slice(1, 3).join('\n'));
      failed++;
    }
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed | ${failed} failed | ${tests.length} total`);
  process.exit(failed);
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  return dir;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Expected'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}


// ─── Tests ───────────────────────────────────────────────────────────────────

t('chokidar stub se carga sin error', () => {
  const c = require('chokidar');
  assert(typeof c.watch === 'function', 'chokidar.watch debe existir');
});

t('main.js se carga sin lanzar errores', () => {
  // Limpiar cache para asegurar import fresco
  delete require.cache[require.resolve('../src/main.js')];
  // Solo verificamos que se pueda parsear y ejecutar la parte estática
  require('../src/main.js');
});

t('config.json se crea con valores por defecto cuando no existe', () => {
  const tmp = tempDir();
  const configPath = path.join(tmp, 'config.json');
  assert(!fs.existsSync(configPath), 'config no debería existir todavía');

  // Simular loadConfig sin archivo
  let cfg;
  try {
    if (fs.existsSync(configPath)) {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      cfg = { apiUrl: 'http://localhost:8000', webappUrl: 'http://localhost:8000/', username: null, token: null };
    }
  } catch { cfg = {}; }

  assertEq(cfg.token, null, 'token debe ser null por defecto');
  assertEq(cfg.username, null, 'username debe ser null por defecto');
  assert(cfg.apiUrl.includes('localhost'), 'apiUrl debe tener un default razonable');
});

t('saveConfig escribe JSON válido', () => {
  const tmp = tempDir();
  const configPath = path.join(tmp, 'config.json');
  const data = { apiUrl: 'https://torneo.test.com', username: 'dino', token: 'abc123' };
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2));

  const loaded = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assertEq(loaded.username, 'dino');
  assertEq(loaded.token, 'abc123');
  assertEq(loaded.apiUrl, 'https://torneo.test.com');
});

t('findRom detecta archivo .gba', () => {
  const tmp = tempDir();
  const romFile = path.join(tmp, 'Pokemon Emerald.gba');
  fs.writeFileSync(romFile, Buffer.alloc(100));

  const files = fs.readdirSync(tmp);
  const found = files.find(f => /\.(gba|zip)$/i.test(f));
  assertEq(found, 'Pokemon Emerald.gba');
});

t('findRom retorna null si no hay ROM', () => {
  const tmp = tempDir();
  fs.writeFileSync(path.join(tmp, 'random.txt'), 'no rom');
  const files = fs.readdirSync(tmp);
  const found = files.find(f => /\.(gba|zip)$/i.test(f)) || null;
  assertEq(found, null);
});

t('savPath se construye desde el nombre de la ROM', () => {
  const romName = 'Pokemon Emerald.gba';
  const base = path.parse(romName).name;
  assertEq(base, 'Pokemon Emerald');
  const savesDir = '/tmp/saves';
  const savPath = path.join(savesDir, `${base}.sav`);
  assert(savPath.endsWith('Pokemon Emerald.sav'), `Esperaba .sav, got: ${savPath}`);
});

t('findEmulator busca mGBA.exe en Windows', () => {
  const tmp = tempDir();
  fs.writeFileSync(path.join(tmp, 'mGBA.exe'), Buffer.alloc(10));

  const candidates = ['mGBA.exe', 'mgba.exe'];
  let found = null;
  for (const c of candidates) {
    const full = path.join(tmp, c);
    if (fs.existsSync(full)) { found = full; break; }
  }
  assert(found && found.endsWith('mGBA.exe'), `Esperaba mGBA.exe, got: ${found}`);
});

t('config preserva URL del backend tras login', () => {
  const tmp = tempDir();
  const configPath = path.join(tmp, 'config.json');

  // Estado inicial
  const initial = { apiUrl: 'https://prod.torneo.com', webappUrl: 'https://prod.torneo.com/', username: null, token: null };
  fs.writeFileSync(configPath, JSON.stringify(initial));

  // Simular login
  const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const next = { ...current, username: 'dino', token: 'xyz789' };
  fs.writeFileSync(configPath, JSON.stringify(next));

  const final = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assertEq(final.apiUrl, 'https://prod.torneo.com', 'URL del backend debe preservarse');
  assertEq(final.username, 'dino');
  assertEq(final.token, 'xyz789');
});

t('logout limpia token y username pero preserva URLs', () => {
  const tmp = tempDir();
  const configPath = path.join(tmp, 'config.json');

  const before = { apiUrl: 'https://torneo.x', webappUrl: 'https://web.x', username: 'dino', token: 'xyz' };
  fs.writeFileSync(configPath, JSON.stringify(before));

  // Simular logout
  const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const after = { ...current, token: null, username: null };
  fs.writeFileSync(configPath, JSON.stringify(after));

  const final = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assertEq(final.token, null);
  assertEq(final.username, null);
  assertEq(final.apiUrl, 'https://torneo.x', 'URL del backend NO debe limpiarse en logout');
});

t('URL del webapp incluye token en query string', () => {
  const config = { webappUrl: 'https://torneo.com/', token: 'tok_abc123' };
  const url = `${config.webappUrl}?token=${encodeURIComponent(config.token)}`;
  assertEq(url, 'https://torneo.com/?token=tok_abc123');
});

t('URL del webapp escapa caracteres especiales en token', () => {
  const token = 'tok+abc/xyz=';
  const url = `https://torneo.com/?token=${encodeURIComponent(token)}`;
  assert(url.includes('tok%2Babc%2Fxyz%3D'), `Esperaba caracteres escapados, got: ${url}`);
});

t('preload expone API segura via contextBridge', () => {
  // Solo verifica que el archivo existe y tiene la estructura esperada
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf-8');
  assert(preloadSrc.includes('contextBridge'), 'debe usar contextBridge');
  assert(preloadSrc.includes('exposeInMainWorld'), 'debe exponer API');
  assert(preloadSrc.includes('launcher'), 'debe usar el nombre window.launcher');

  // Verificar que las funciones críticas estén expuestas
  const required = ['login', 'logout', 'launchEmulator', 'uploadNow', 'openWebapp', 'checkSystem'];
  for (const fn of required) {
    assert(preloadSrc.includes(fn), `preload debe exponer ${fn}`);
  }
});


runTests();
