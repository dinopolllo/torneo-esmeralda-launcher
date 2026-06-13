--[[
  emerald_tracker.lua — Tracker en tiempo real para Pokémon Esmeralda
  ====================================================================
  v3 (2026-06-11):
    - Auto-detecta versión del ROM (BPEE/BPES) y configura SB1/SB2/storage
    - Entrega real de items a la mochila (pocket correcto)
    - Entrega real de Pokémon al PC (BoxPokemon de 80B con encriptación + checksum)
    - Logs verbose al arrancar para depurar conexión y RAM
    - Decodificación correcta del species ID (tabla ORDER de substructs)
    - Canal TCP bidireccional con el launcher

  Carga en mGBA: Tools → Scripting → Load Script
  (el launcher lo carga automáticamente al iniciar el emulador)
--]]

local LAUNCHER_PORT  = 8765
local POLL_INTERVAL  = 60   -- ~1s @60fps
local RECONNECT_INT  = 300  -- ~5s

local function log(msg) console:log("[tracker] " .. tostring(msg)) end

-- ── Auto-detección de ROM ────────────────────────────────────────────────────
-- Header ROM en 0x080000A0..0x080000B0
--   0xA0..0xAB : Game Title (12 bytes ASCII)
--   0xAC..0xAF : Game Code   (4 bytes ASCII)
-- Códigos conocidos:
--   BPEE = Emerald US English
--   BPES = Emerald Spanish
--   BPEF = Emerald French
--   BPED = Emerald German
--   BPEI = Emerald Italian
--   BPEJ = Emerald Japanese
local function readRomCode()
  local b1 = emu:read8(0x080000AC)
  local b2 = emu:read8(0x080000AD)
  local b3 = emu:read8(0x080000AE)
  local b4 = emu:read8(0x080000AF)
  return string.char(b1, b2, b3, b4)
end

-- Configuración por versión: SB1/SB2/Storage en IWRAM + gPlayerParty en EWRAM.
-- `language` es el código Gen III para BoxPokemon.language (1=JP, 2=EN, 3=FR, 4=IT, 5=DE, 6=ES).
local ROM_PROFILES = {
  BPEE = {  -- US English 1.0
    name = "Emerald US (BPEE)", language = 2,
    sb1_ptr = 0x03005D8C, sb2_ptr = 0x03005D90, storage_ptr = 0x03005D94,
    party = 0x020244EC,
  },
  BPES = {  -- Spanish 1.0
    name = "Emerald ES (BPES)", language = 6,
    sb1_ptr = 0x030057BC, sb2_ptr = 0x030057C0, storage_ptr = 0x030057C4,
    party = 0x020244EC,
  },
  BPEF = {  -- French 1.0
    name = "Emerald FR (BPEF)", language = 3,
    sb1_ptr = 0x030057BC, sb2_ptr = 0x030057C0, storage_ptr = 0x030057C4,
    party = 0x020244EC,
  },
  BPED = {  -- German 1.0
    name = "Emerald DE (BPED)", language = 5,
    sb1_ptr = 0x030057BC, sb2_ptr = 0x030057C0, storage_ptr = 0x030057C4,
    party = 0x020244EC,
  },
  BPEI = {  -- Italian 1.0
    name = "Emerald IT (BPEI)", language = 4,
    sb1_ptr = 0x030057BC, sb2_ptr = 0x030057C0, storage_ptr = 0x030057C4,
    party = 0x020244EC,
  },
}

local CFG = nil       -- se asigna en init()
local ROM_CODE = "?"

-- ── Offsets dentro de SaveBlock2 ────────────────────────────────────────────
local SB2_PLAYER_NAME = 0x00  -- 7 bytes
local SB2_GENDER      = 0x08
local SB2_TRAINER_ID  = 0x0A  -- 4 bytes (low 2 = visible)
local SB2_BADGES      = 0x1F  -- 1 byte
local SB2_ENC_KEY     = 0xAC  -- u32

-- struct Pokedex dentro de SB2: SB2 + 0x18; campo owned[] empieza en +0x10 dentro de Pokedex.
local SB2_POKEDEX_OWNED = 0x18 + 0x10   -- = 0x28
local POKEDEX_FLAG_BYTES = 49           -- ceil(386 / 8)

-- struct SaveBlock1 (mapa). Idéntico en ES/FR/DE/IT.
local SB1_MAP_GROUP = 0x4
local SB1_MAP_NUM   = 0x5

-- Offsets de mochila dentro de SaveBlock1 (idénticos en US/ES/FR/DE/IT)
local BAG_ITEMS    = 0x0560  ; local BAG_ITEMS_N    = 30
local BAG_KEYITEMS = 0x05D8  ; local BAG_KEYITEMS_N = 30
local BAG_BALLS    = 0x0650  ; local BAG_BALLS_N    = 16
local BAG_TMHMS    = 0x0690  ; local BAG_TMHMS_N    = 64
local BAG_BERRIES  = 0x0790  ; local BAG_BERRIES_N  = 46

-- Constantes Pokémon
local MON_SIZE       = 0x64   -- party Pokemon (100 bytes)
local BOXMON_SIZE    = 0x50   -- box Pokemon (80 bytes)
local STORAGE_FIRST_SLOT = 0x04   -- struct PokemonStorage: u8 currentBox + 3B padding antes de boxes
local BOX_SLOTS      = 30
local TOTAL_BOXES    = 14

-- ── Mapeo slug → Gen III item ID ─────────────────────────────────────────────
local ITEM_IDS = {
  ['master-ball']=1, ['ultra-ball']=2, ['great-ball']=3, ['poke-ball']=4,
  ['safari-ball']=5, ['net-ball']=6, ['dive-ball']=7, ['nest-ball']=8,
  ['repeat-ball']=9, ['timer-ball']=10, ['luxury-ball']=11, ['premier-ball']=12,
  ['potion']=13, ['antidote']=14, ['burn-heal']=15, ['ice-heal']=16,
  ['awakening']=17, ['paralyze-heal']=18, ['full-restore']=19, ['max-potion']=20,
  ['hyper-potion']=21, ['super-potion']=22, ['full-heal']=23, ['revive']=24,
  ['max-revive']=25, ['ether']=34, ['max-ether']=35, ['elixir']=36, ['max-elixir']=37,
  ['rare-candy']=68,
  ['cheri-berry']=133, ['chesto-berry']=134, ['pecha-berry']=135, ['rawst-berry']=136,
  ['aspear-berry']=137, ['leppa-berry']=138, ['oran-berry']=139, ['persim-berry']=140,
  ['lum-berry']=141, ['sitrus-berry']=142, ['figy-berry']=143, ['wiki-berry']=144,
  ['mago-berry']=145, ['aguav-berry']=146, ['iapapa-berry']=147, ['razz-berry']=148,
  ['pinap-berry']=152, ['pomeg-berry']=153, ['kelpsy-berry']=154, ['qualot-berry']=155,
  ['hondew-berry']=156, ['grepa-berry']=157, ['tamato-berry']=158,
  ['liechi-berry']=168, ['ganlon-berry']=169, ['salac-berry']=170, ['petaya-berry']=171,
  ['apicot-berry']=172, ['lansat-berry']=173, ['starf-berry']=174,
  ['bright-powder']=179, ['white-herb']=180, ['macho-brace']=181, ['exp-share']=182,
  ['quick-claw']=183, ['soothe-bell']=184, ['mental-herb']=185, ['choice-band']=186,
  ['kings-rock']=187, ['silver-powder']=188, ['amulet-coin']=189,
  ['deep-sea-tooth']=192, ['deep-sea-scale']=193,
  ['focus-band']=196, ['lucky-egg']=197, ['scope-lens']=198, ['metal-coat']=199,
  ['leftovers']=200, ['soft-sand']=203, ['hard-stone']=204, ['miracle-seed']=205,
  ['black-glasses']=206, ['black-belt']=207, ['magnet']=208, ['mystic-water']=209,
  ['sharp-beak']=210, ['poison-barb']=211, ['never-melt-ice']=212, ['spell-tag']=213,
  ['twisted-spoon']=214, ['charcoal']=215, ['dragon-fang']=216, ['silk-scarf']=217,
  ['shell-bell']=219,
  ['tm-dragon']=290, ['tm-water']=291, ['tm-ice']=301, ['tm-normal']=303,
  ['tm-electric']=312, ['tm-ground']=314, ['tm-psychic']=317, ['tm-ghost']=318,
  ['tm-fighting']=319, ['tm-fire']=323,
}

local SUB_A_POS = {
  [0]=0,[1]=0,[2]=0,[3]=0,[4]=0,[5]=0,
  [6]=1,[7]=1,[8]=2,[9]=3,[10]=2,[11]=3,
  [12]=1,[13]=1,[14]=2,[15]=3,[16]=2,[17]=3,
  [18]=1,[19]=1,[20]=2,[21]=3,[22]=2,[23]=3,
}

local function pocketForItem(itemId)
  if itemId >= 1 and itemId <= 12 then return 'balls' end
  if itemId >= 133 and itemId <= 175 then return 'berries' end
  if itemId >= 289 and itemId <= 376 then return 'tmhm' end
  return 'items'
end

-- ── Estado ───────────────────────────────────────────────────────────────────
local prevBadges    = -1
local prevHP        = {-1, -1, -1, -1, -1, -1}
local prevMapId     = -1
local stateTicks    = 0    -- conteo de polls (1 por segundo) para emisión periódica
local sock          = nil
local frameCount    = 0
local reconnectWait = 0
local rxBuffer      = ""

-- ── Socket helpers ───────────────────────────────────────────────────────────
local handleIncomingLine

local function onSocketError(err)
  log("Socket error: " .. tostring(err))
  if sock then sock:close(); sock = nil end
end

local function onSocketReceived()
  if not sock then return end
  while true do
    local chunk, err = sock:receive(4096)
    if not chunk or #chunk == 0 then break end
    rxBuffer = rxBuffer .. chunk
    while true do
      local nl = rxBuffer:find("\n", 1, true)
      if not nl then break end
      local line = rxBuffer:sub(1, nl - 1)
      rxBuffer = rxBuffer:sub(nl + 1)
      handleIncomingLine(line)
    end
    if err then break end
  end
end

local function connectToLauncher()
  if sock then sock:close(); sock = nil end
  rxBuffer = ""
  local s = socket.tcp()
  s:add("error", onSocketError)
  s:add("received", onSocketReceived)
  if s:connect("127.0.0.1", LAUNCHER_PORT) then
    sock = s
    log("Conectado al launcher en 127.0.0.1:" .. LAUNCHER_PORT)
  else
    s:close()
    log("Launcher no disponible — reintento en 5s")
  end
end

local function send(payloadStr)
  if not sock then return end
  sock:send(payloadStr .. "\n")
end

local function tojson(tbl)
  local parts = {}
  for k, v in pairs(tbl) do
    local val
    if type(v) == "number" then val = tostring(v)
    elseif type(v) == "boolean" then val = tostring(v)
    else val = '"' .. tostring(v):gsub('"', '\\"') .. '"' end
    table.insert(parts, '"' .. k .. '":' .. val)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function sendEvent(evt) send(tojson(evt)) end

-- ── Lectura de memoria con guards ────────────────────────────────────────────
local function getSB(ptrAddr)
  local p = emu:read32(ptrAddr)
  if p < 0x02000000 or p > 0x0203FFFF then return nil end
  return p
end

local function getBadgeByte()
  if not CFG then return -1 end
  local sb2 = getSB(CFG.sb2_ptr)
  if not sb2 then return -1 end
  return emu:read8(sb2 + SB2_BADGES)
end

local function getEncryptionKey()
  if not CFG then return 0 end
  local sb2 = getSB(CFG.sb2_ptr)
  if not sb2 then return 0 end
  return emu:read32(sb2 + SB2_ENC_KEY)
end

local function getEncKey16() return getEncryptionKey() & 0xFFFF end

local function getTrainerId()
  if not CFG then return 0x12345678 end
  local sb2 = getSB(CFG.sb2_ptr)
  if not sb2 then return 0x12345678 end
  return emu:read32(sb2 + SB2_TRAINER_ID)
end

local function getPlayerName10()
  -- nombre del entrenador (7 bytes) + padding 0xFF para llegar a 10 bytes
  if not CFG then return {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF} end
  local sb2 = getSB(CFG.sb2_ptr)
  if not sb2 then return {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF} end
  local out = {}
  for i = 0, 6 do out[#out+1] = emu:read8(sb2 + SB2_PLAYER_NAME + i) end
  for i = 7, 9 do out[#out+1] = 0xFF end
  return out
end

local function getSpecies(slot)
  local base  = CFG.party + slot * MON_SIZE
  local hpMax = emu:read16(base + 0x58)
  if hpMax == 0 then return 0 end
  local pid  = emu:read32(base + 0x00)
  local otid = emu:read32(base + 0x04)
  local key  = pid ~ otid
  local aPos  = SUB_A_POS[pid % 24]
  local aBase = base + 0x20 + aPos * 12
  local raw       = emu:read32(aBase)
  local decrypted = raw ~ key
  return decrypted & 0xFFFF
end

local function getPartyLevel(slot)
  local base  = CFG.party + slot * MON_SIZE
  local hpMax = emu:read16(base + 0x58)
  if hpMax == 0 then return 0 end
  return emu:read8(base + 0x54)
end

-- ── Lecturas para el sistema de contratos ────────────────────────────────────
local function getMapId()
  if not CFG then return 0 end
  local sb1 = getSB(CFG.sb1_ptr)
  if not sb1 then return 0 end
  local g = emu:read8(sb1 + SB1_MAP_GROUP)
  local n = emu:read8(sb1 + SB1_MAP_NUM)
  return (g << 8) | n
end

-- popcount8 simple
local POPCOUNT8 = {}
for i = 0, 255 do
  local c = 0; local v = i
  while v > 0 do c = c + (v & 1); v = v >> 1 end
  POPCOUNT8[i] = c
end

local function getPokedexCount()
  if not CFG then return 0 end
  local sb2 = getSB(CFG.sb2_ptr)
  if not sb2 then return 0 end
  local total = 0
  for i = 0, POKEDEX_FLAG_BYTES - 1 do
    total = total + POPCOUNT8[emu:read8(sb2 + SB2_POKEDEX_OWNED + i)]
  end
  return total
end

local function getBoxCount()
  if not CFG then return 0 end
  local storage = getSB(CFG.storage_ptr)
  if not storage then return 0 end
  local base = storage + STORAGE_FIRST_SLOT
  local count = 0
  for box = 0, TOTAL_BOXES - 1 do
    for slot = 0, BOX_SLOTS - 1 do
      local addr = base + (box * BOX_SLOTS + slot) * BOXMON_SIZE
      if emu:read32(addr) ~= 0 then count = count + 1 end
    end
  end
  return count
end

local function getPartySnapshot()
  local species, levels, count = {}, {}, 0
  for slot = 0, 5 do
    local sp = getSpecies(slot)
    local lv = getPartyLevel(slot)
    species[slot + 1] = sp
    levels[slot + 1]  = lv
    if sp ~= 0 then count = count + 1 end
  end
  return species, levels, count
end

-- Serializa una lista de enteros como "[1,2,3]" para inyectarlo en JSON
local function intListToJson(list)
  local parts = {}
  for i = 1, #list do parts[i] = tostring(list[i] or 0) end
  return "[" .. table.concat(parts, ",") .. "]"
end

-- ── Entrega de items a la mochila ────────────────────────────────────────────
local POCKET_INFO = {
  items   = {off = BAG_ITEMS,    n = BAG_ITEMS_N,    cap = 999},
  ['key'] = {off = BAG_KEYITEMS, n = BAG_KEYITEMS_N, cap = 1},
  balls   = {off = BAG_BALLS,    n = BAG_BALLS_N,    cap = 999},
  tmhm    = {off = BAG_TMHMS,    n = BAG_TMHMS_N,    cap = 99},
  berries = {off = BAG_BERRIES,  n = BAG_BERRIES_N,  cap = 999},
}

-- Retorna (ok:boolean, reason:string)
local function giveItemToBag(itemId, qty)
  if not CFG then return false, "sin CFG ROM" end
  local sb1 = getSB(CFG.sb1_ptr)
  if not sb1 then return false, "SB1_PTR inválido (carga la partida)" end
  local pocketName = pocketForItem(itemId)
  local pocket = POCKET_INFO[pocketName]
  if not pocket then return false, "pocket desconocido" end
  local k16 = getEncKey16()

  for i = 0, pocket.n - 1 do
    local addr = sb1 + pocket.off + i * 4
    local id   = emu:read16(addr)
    if id == itemId then
      local cur = emu:read16(addr + 2) ~ k16
      local newQty = math.min(cur + qty, pocket.cap)
      emu:write16(addr + 2, newQty ~ k16)
      log(string.format("Item %d +%d (stack pocket=%s slot=%d: %d→%d)",
        itemId, qty, pocketName, i, cur, newQty))
      return true, "stacked"
    end
  end
  for i = 0, pocket.n - 1 do
    local addr = sb1 + pocket.off + i * 4
    if emu:read16(addr) == 0 then
      emu:write16(addr, itemId)
      emu:write16(addr + 2, math.min(qty, pocket.cap) ~ k16)
      log(string.format("Item %d ×%d (nuevo pocket=%s slot=%d)",
        itemId, qty, pocketName, i))
      return true, "new_slot"
    end
  end
  log(string.format("Pocket '%s' lleno — item %d no entregado (usa o vende items para liberar slots)",
    pocketName, itemId))
  return false, "pocket_lleno:" .. pocketName
end

-- ── Entrega de Pokémon al PC ─────────────────────────────────────────────────

-- Exp acumulada para nivel 5 (curva Medium-Fast; aceptable para casi todos)
local EXP_LEVEL5_MEDIUM_FAST = 125

-- PRNG simple para PID
local _prngState = 0x12345678
local function nextPrng()
  _prngState = (_prngState * 1103515245 + 12345) & 0xFFFFFFFF
  return _prngState
end

-- Encuentra un PID que cumpla pid%24==0 (orden ABCD) y opcionalmente shiny.
--
-- Probabilidades:
--   - pid % 24 == 0           ≈ 4.17%
--   - shiny                   ≈ 0.012%
--   - combinada al azar       ≈ 1/200k (4096 intentos ≠ confiable)
--
-- Para shinies usamos construcción dirigida:
--   1. elegir pid_hi al azar
--   2. fijar pid_lo = (otid_lo XOR otid_hi XOR pid_hi) XOR shinyRoll (shinyRoll∈[0,7])
--   3. verificar pid % 24 == 0; si no, probar otro pid_hi
-- Esto sube la tasa de éxito a >99.9% con ~200 intentos.
local function pickPid(otid, isShiny)
  -- Re-seed con datos vivos para variabilidad entre llamadas
  _prngState = (_prngState ~ getEncryptionKey() ~ frameCount) & 0xFFFFFFFF

  local otid_lo = otid & 0xFFFF
  local otid_hi = (otid >> 16) & 0xFFFF

  if isShiny then
    for _ = 1, 8192 do
      local pid_hi = nextPrng() & 0xFFFF
      local roll = nextPrng() & 0x7  -- 0..7
      local pid_lo = (otid_lo ~ otid_hi ~ pid_hi ~ roll) & 0xFFFF
      local pid = (pid_hi << 16) | pid_lo
      if pid % 24 == 0 then return pid end
    end
    log("pickPid: no se encontró PID shiny — fallback no shiny")
  end

  -- No shiny (o fallback): solo necesitamos pid % 24 == 0
  for _ = 1, 65536 do
    local pid = nextPrng()
    if pid % 24 == 0 then return pid end
  end
  return 0x18  -- fallback ABCD-order
end

-- Calcula el checksum como suma de los 24 u16 de las 4 substructs (decoded)
local function checksum48(buf)
  local sum = 0
  for i = 1, 48, 2 do
    sum = (sum + buf[i] + buf[i + 1] * 256) & 0xFFFF
  end
  return sum
end

-- Construye los 48 bytes de las 4 substructs (orden ABCD asumido)
local function buildSubstructs(species, otid, level)
  local s = {}
  for i = 1, 48 do s[i] = 0 end

  -- Substruct A — Growth (offset 0..11)
  s[1]  = species & 0xFF
  s[2]  = (species >> 8) & 0xFF
  -- heldItem (0): s[3] s[4]
  -- experience u32 (le): exp acumulada para nivel level (usamos medium-fast aprox)
  local exp = EXP_LEVEL5_MEDIUM_FAST
  if level > 5 then exp = level * level * level end  -- aproximación
  s[5]  = exp & 0xFF
  s[6]  = (exp >> 8) & 0xFF
  s[7]  = (exp >> 16) & 0xFF
  s[8]  = (exp >> 24) & 0xFF
  s[9]  = 0      -- ppBonuses
  s[10] = 70     -- friendship
  -- s[11], s[12] padding/unknown

  -- Substruct B — Attacks (offset 12..23)
  -- Moves: usar TACKLE (33) en slot 1, los demás 0 (juego puede manejarlo)
  s[13] = 33     -- TACKLE
  s[14] = 0
  s[21] = 35     -- PP[0]=35

  -- Substruct C — EVs/Condition (offset 24..35): todo 0 (ya inicializado)

  -- Substruct D — Misc (offset 36..47)
  -- pokerus = 0
  s[37] = 0
  -- metLocation = 0xFE (fateful encounter / regalo)
  s[38] = 0xFE
  -- origins u16: level (7b) | game (4b) | ball (4b) | otGender (1b)
  -- Emerald = 3, Poke Ball = 4, female otGender = 0
  local origins = (level & 0x7F) | (3 << 7) | (4 << 11)
  s[39] = origins & 0xFF
  s[40] = (origins >> 8) & 0xFF
  -- IVs u32: hp(5)|atk(5)|def(5)|spe(5)|spa(5)|spd(5)|isEgg(1)|ability(1)
  -- Damos 25/25/25/25/25/25 (decentes), no egg, ability 0
  local ivs = 25 | (25 << 5) | (25 << 10) | (25 << 15) | (25 << 20) | (25 << 25)
  s[41] = ivs & 0xFF
  s[42] = (ivs >> 8) & 0xFF
  s[43] = (ivs >> 16) & 0xFF
  s[44] = (ivs >> 24) & 0xFF
  -- ribbons u32 = 0

  return s
end

-- Encripta los 48 bytes con el u32 key = personality XOR otid (cada 4 bytes)
local function encryptSubstructs(buf, key)
  local out = {}
  for i = 0, 11 do  -- 12 u32 words
    local b0 = buf[i*4 + 1]
    local b1 = buf[i*4 + 2]
    local b2 = buf[i*4 + 3]
    local b3 = buf[i*4 + 4]
    local w  = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    local e  = w ~ key
    out[i*4 + 1] = e & 0xFF
    out[i*4 + 2] = (e >> 8) & 0xFF
    out[i*4 + 3] = (e >> 16) & 0xFF
    out[i*4 + 4] = (e >> 24) & 0xFF
  end
  return out
end

-- Encuentra el primer slot vacío en cualquier caja del PC. Retorna addr o nil.
local function findEmptyBoxSlot()
  local storage = getSB(CFG.storage_ptr)
  if not storage then return nil end
  for box = 0, TOTAL_BOXES - 1 do
    for slot = 0, BOX_SLOTS - 1 do
      local idx = box * BOX_SLOTS + slot
      local addr = storage + STORAGE_FIRST_SLOT + idx * BOXMON_SIZE
      -- Vacío si personality y otId son cero (= todo 0x00)
      local pid = emu:read32(addr + 0x00)
      local oid = emu:read32(addr + 0x04)
      if pid == 0 and oid == 0 then
        return addr, box, slot
      end
    end
  end
  return nil
end

-- NatDex (PokeAPI) → species ID interno del juego (Gen III decomp).
-- Gen I (1-151) y Gen II (152-251): internal == NatDex.
-- Gen III / Hoenn (252-386): internal = NatDex + 25 (hay 25 placeholders
-- "??????????" entre Celebi (251) y Treecko (277) en la tabla interna).
local function natdexToInternal(natdex)
  if natdex >= 252 and natdex <= 386 then
    return natdex + 25
  end
  return natdex
end

local function givePokemonToPC(pokemonId, name, isShiny)
  if not CFG then log("Sin CFG ROM"); return false end
  if pokemonId == 0 then return false end
  local addr, box, slot = findEmptyBoxSlot()
  if not addr then
    log("PC lleno — no se puede entregar Pokémon")
    return false
  end

  local species = natdexToInternal(pokemonId)
  local otid  = getTrainerId()
  local pid   = pickPid(otid, isShiny)
  local key   = pid ~ otid
  local level = 5  -- todos los huevos eclosionan al nivel 5

  -- Construir substructs y encriptarlos (usando species INTERNO, no NatDex)
  local subs    = buildSubstructs(species, otid, level)
  local checksum = checksum48(subs)
  local enc     = encryptSubstructs(subs, key)

  -- Header de BoxPokemon (32 bytes)
  emu:write32(addr + 0x00, pid)
  emu:write32(addr + 0x04, otid)
  -- nickname: usar nombre del entrenador como placeholder (10 bytes)
  -- (el juego mostrará el nombre del Pokémon si language está bien)
  -- nickname vacío (0xFF terminator) → el juego muestra el nombre de la especie
  for i = 0, 9 do emu:write8(addr + 0x08 + i, 0xFF) end
  -- language: usar el de la ROM detectada (evita el "?" cuando hay mismatch)
  emu:write8(addr + 0x12, CFG.language or 2)
  emu:write8(addr + 0x13, 0x02)  -- misc flags: bit1 = hasSpecies
  -- otName del entrenador real
  local pname = getPlayerName10()
  for i = 0, 6 do emu:write8(addr + 0x14 + i, pname[i+1] or 0xFF) end
  emu:write8(addr + 0x1B, 0x00)  -- markings
  emu:write16(addr + 0x1C, checksum)
  emu:write16(addr + 0x1E, 0)    -- padding

  -- Substructs encriptados
  for i = 1, 48 do
    emu:write8(addr + 0x1F + i, enc[i])  -- 0x20..0x4F
  end

  log(string.format("Pokémon #%d %s%s → caja %d slot %d (PID=0x%08X OT=0x%04X)",
    pokemonId, name, isShiny and " SHINY" or "", box, slot, pid, otid & 0xFFFF))
  return true
end

-- ── Handler de mensajes entrantes ────────────────────────────────────────────
local function parseField(line, field, isNum)
  if isNum then
    local v = line:match('"' .. field .. '":%s*(-?%d+)')
    return v and tonumber(v) or nil
  end
  return line:match('"' .. field .. '":%s*"([^"]*)"')
end
local function parseBool(line, field)
  return line:match('"' .. field .. '":%s*true') ~= nil
end

handleIncomingLine = function(line)
  if not line or line == "" then return end
  local mtype = parseField(line, "type", false)
  if not mtype then log("Mensaje sin 'type'"); return end
  if mtype == "ping" then send('{"type":"pong"}'); return end

  if mtype == "give_item" then
    local rid  = parseField(line, "reward_id", true) or 0
    local slug = parseField(line, "slug", false) or ""
    local qty  = parseField(line, "qty", true) or 1
    -- Slugs que son moneda solo del hub (no van al juego). Si llegan, ACK ok=true
    -- para que el backend los marque entregados y dejen de spammear.
    if slug == "egg-ticket" then
      log("Skip 'egg-ticket' (moneda solo del hub)")
      sendEvent({type = "reward_ack", kind = "item", reward_id = rid, ok = true})
      return
    end
    local itemId = ITEM_IDS[slug]
    log(string.format("RX give_item rid=%d slug=%s qty=%d → id=%s",
        rid, slug, qty, tostring(itemId)))
    local okv, reason = false, "slug_desconocido"
    if itemId then okv, reason = giveItemToBag(itemId, qty)
    else log("Slug desconocido: " .. slug) end
    sendEvent({type = "reward_ack", kind = "item", reward_id = rid, ok = okv, reason = reason})
    return
  end

  if mtype == "give_pokemon" then
    local rid = parseField(line, "reward_id", true) or 0
    local pid = parseField(line, "pokemon_id", true) or 0
    local nm  = parseField(line, "name", false) or "?"
    local sh  = parseBool(line, "is_shiny")
    log(string.format("RX give_pokemon rid=%d id=%d name=%s shiny=%s",
        rid, pid, nm, tostring(sh)))
    local okv = givePokemonToPC(pid, nm, sh)
    sendEvent({type = "reward_ack", kind = "pokemon", reward_id = rid, ok = okv})
    return
  end

  log("Tipo desconocido: " .. mtype)
end

-- ── Inicialización ───────────────────────────────────────────────────────────
local function init()
  ROM_CODE = readRomCode()
  CFG = ROM_PROFILES[ROM_CODE]
  if CFG then
    log("=================================================")
    log("Tracker v3 — ROM detectada: " .. CFG.name)
    log(string.format("SB1_PTR=0x%08X SB2_PTR=0x%08X STORAGE=0x%08X",
        CFG.sb1_ptr, CFG.sb2_ptr, CFG.storage_ptr))
    log(string.format("PARTY_BASE=0x%08X", CFG.party))
    log("=================================================")
  else
    log("=================================================")
    log("ROM CODE='" .. ROM_CODE .. "' NO RECONOCIDA — usando perfil BPEE por defecto")
    CFG = ROM_PROFILES.BPEE
    log("=================================================")
  end
  -- Seed PRNG con frame inicial (variará por sesión)
  _prngState = (_prngState ~ (emu:read32(0x080000A0) or 0x12345678)) & 0xFFFFFFFF
  connectToLauncher()
end

-- ── Emisión de game_state (snapshot vivo para el sistema de contratos) ──────
local function sendGameState()
  if not sock or not CFG then return end
  local species, levels, count = getPartySnapshot()
  local badges = getBadgeByte()
  if badges < 0 then badges = 0 end
  local payload = string.format(
    '{"type":"game_state","badges":%d,"party_species":%s,"party_levels":%s,'
    .. '"party_count":%d,"pokedex_count":%d,"box_count":%d,"map_id":%d}',
    badges, intListToJson(species), intListToJson(levels),
    count, getPokedexCount(), getBoxCount(), getMapId()
  )
  send(payload)
end


-- ── Callbacks ────────────────────────────────────────────────────────────────
callbacks:add("start", init)
callbacks:add("reset", function()
  prevBadges = -1
  for i = 1, 6 do prevHP[i] = -1 end
  prevMapId = -1
  stateTicks = 0
  init()
end)
callbacks:add("stop", function()
  if sock then sock:close(); sock = nil end
end)

callbacks:add("frame", function()
  frameCount = frameCount + 1

  if not sock then
    reconnectWait = reconnectWait + 1
    if reconnectWait >= RECONNECT_INT then
      reconnectWait = 0
      connectToLauncher()
    end
    return
  end

  if frameCount % POLL_INTERVAL ~= 0 then return end
  if not CFG then return end

  local badges = getBadgeByte()
  if badges >= 0 and prevBadges >= 0 and badges ~= prevBadges then
    local gained = badges & (~prevBadges)
    for i = 0, 7 do
      if (gained & (1 << i)) ~= 0 then
        sendEvent({type = "badge_earned", badge_index = i})
      end
    end
  end
  if badges >= 0 then prevBadges = badges end

  for slot = 0, 5 do
    local base  = CFG.party + slot * MON_SIZE
    local hpMax = emu:read16(base + 0x58)
    if hpMax == 0 or hpMax > 714 then
      prevHP[slot + 1] = -1
    else
      local hpCur = emu:read16(base + 0x56)
      local level = emu:read8(base + 0x54)
      if prevHP[slot + 1] > 0 and hpCur == 0 then
        local spId = getSpecies(slot)
        sendEvent({type = "pokemon_fainted", slot = slot + 1, level = level, species_id = spId})
      end
      prevHP[slot + 1] = hpCur
    end
  end

  -- game_state: enviar al cambiar de mapa o como respaldo cada 5s
  local mapId = getMapId()
  stateTicks = stateTicks + 1
  local mapChanged = (mapId ~= 0 and mapId ~= prevMapId)
  if mapChanged or stateTicks >= 5 then
    sendGameState()
    stateTicks = 0
    if mapChanged then prevMapId = mapId end
  end
end)

-- También intentar init al cargar el script (algunos mGBA no disparan "start" al hot-load)
init()
log("Polling cada " .. POLL_INTERVAL .. " frames; reintento de conexión cada " .. RECONNECT_INT .. " frames")
