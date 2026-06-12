/**
 * emerald_tracker.js — Tracker en tiempo real para Pokémon Esmeralda
 * ==================================================================
 * Corre dentro de mGBA via Tools → Scripting → Load Script
 * (mGBA lo recuerda y auto-carga en sesiones futuras)
 *
 * Detecta cada ~1 segundo:
 *  - Nuevas medallas (badge_earned)
 *  - Pokémon que llegan a HP 0 (pokemon_fainted)
 *
 * Envía los eventos por TCP al launcher (puerto 8765).
 *
 * Direcciones de RAM para Pokémon Esmeralda US 1.0
 * Si tu ROM tiene patches, las direcciones pueden variar.
 * Verificalas con un debugger si los eventos no se detectan.
 */

// ── Direcciones de memoria (Pokémon Esmeralda US 1.0) ──────────────────────
const SB2_PTR      = 0x030057C0;  // gSaveBlock2Ptr (IWRAM) → apunta a SaveBlock2
const BADGE_IN_SB2 = 0x1F;       // offset del badge byte dentro de SaveBlock2
const PARTY_BASE   = 0x020244EC; // gPlayerParty (EWRAM, 6 × 100 bytes)
const MON_SIZE     = 0x64;       // 100 bytes por Pokémon
const OFF_HP_CUR   = 0x56;       // HP actual dentro del struct del Pokémon
const OFF_HP_MAX   = 0x58;       // HP máximo
const OFF_LEVEL    = 0x54;       // Nivel

// ── Configuración ──────────────────────────────────────────────────────────
const LAUNCHER_PORT  = 8765;
const POLL_INTERVAL  = 60;   // frames entre cada lectura (~1 seg a 60 fps)

// ── Estado previo ──────────────────────────────────────────────────────────
let prevBadges = -1;
const prevHP   = new Array(6).fill(-1);

// ── Lectura de memoria ─────────────────────────────────────────────────────
function r8(addr)  { return mba.memory.read8(addr);  }
function r16(addr) { return mba.memory.read16(addr); }
function r32(addr) { return mba.memory.read32(addr); }

function getBadgeByte() {
    const sb2 = r32(SB2_PTR);
    if (sb2 < 0x02000000 || sb2 > 0x0203FFFF) return -1; // puntero inválido
    return r8(sb2 + BADGE_IN_SB2);
}

// ── Envío de evento al launcher ────────────────────────────────────────────
function sendEvent(evt) {
    const json = JSON.stringify(evt);
    try {
        // mGBA 0.10+ expone 'socket' como módulo global de scripting
        const sock = socket.openTcp('127.0.0.1', LAUNCHER_PORT);
        if (!sock) {
            console.log('[tracker] No se pudo conectar al launcher (¿está corriendo?)');
            return;
        }
        sock.send(json + '\n');
        sock.close();
        console.log('[tracker] Evento enviado: ' + json);
    } catch (e) {
        console.log('[tracker] Error de socket: ' + String(e));
    }
}

// ── Loop principal (cada POLL_INTERVAL frames) ─────────────────────────────
let frame = 0;

mba.callbacks.frame.add(function () {
    if (++frame % POLL_INTERVAL !== 0) return;

    // ─ Badges ──────────────────────────────────────────────────────────────
    const badges = getBadgeByte();

    if (badges >= 0 && prevBadges >= 0 && badges !== prevBadges) {
        const gained = badges & ~prevBadges;
        for (let i = 0; i < 8; i++) {
            if (gained & (1 << i)) {
                sendEvent({ type: 'badge_earned', badge_index: i });
            }
        }
    }
    if (badges >= 0) prevBadges = badges;

    // ─ HP del equipo ───────────────────────────────────────────────────────
    for (let slot = 0; slot < 6; slot++) {
        const base   = PARTY_BASE + slot * MON_SIZE;
        const hpMax  = r16(base + OFF_HP_MAX);

        // Slot vacío o datos no cargados aún
        if (hpMax === 0 || hpMax > 714) { // HP max de Blissey = 714 en Lv100
            prevHP[slot] = -1;
            continue;
        }

        const hpCur = r16(base + OFF_HP_CUR);
        const level = r8(base + OFF_LEVEL);

        // Pokémon que pasó de tener HP > 0 a HP = 0
        if (prevHP[slot] > 0 && hpCur === 0) {
            sendEvent({ type: 'pokemon_fainted', slot: slot + 1, level });
        }

        prevHP[slot] = hpCur;
    }
});

console.log('[tracker] Emerald Tracker iniciado — monitoreando badges y equipo cada ' + POLL_INTERVAL + ' frames');
console.log('[tracker] Conectando al launcher en puerto ' + LAUNCHER_PORT);
