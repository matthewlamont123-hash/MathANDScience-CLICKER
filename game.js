/**
 * Starlight Idle — deep idle clicker
 * ------------------------------------------------------------
 * Sections: SciNum · Format · Config · State · Economy · Upgrades
 *           · Persistence · Achievements · UI · Loop
 * ------------------------------------------------------------
 * Performance: game logic ticks on a fixed dt budget; SciNum uses
 * mantissa/exponent to avoid Infinity. UI syncs via requestAnimationFrame.
 */

// =============================================================================
// SciNum — scientific notation (mantissa × 10^exponent), all values ≥ 0
// =============================================================================

const SciNum = (() => {
  /** @typedef {{ m: number, e: number }} SN */

  const ZERO = Object.freeze({ m: 0, e: 0 });

  function clone(x) {
    return { m: x.m, e: x.e };
  }

  function normalize(m, e) {
    if (!isFinite(m) || m === 0) return { m: 0, e: 0 };
    let sign = m < 0 ? -1 : 1;
    m = Math.abs(m);
    while (m >= 10) {
      m /= 10;
      e++;
    }
    while (m < 1) {
      m *= 10;
      e--;
    }
    // avoid IEEE dust
    if (m < 1e-15) return { m: 0, e: 0 };
    return { m: m * sign, e };
  }

  function fromNumber(n) {
    if (!isFinite(n) || n <= 0) return { m: 0, e: 0 };
    const e = Math.floor(Math.log10(n));
    const m = n / Math.pow(10, e);
    return normalize(m, e);
  }

  /**
   * Parse "m,e" string from save
   * @param {string} s
   */
  function fromSerialized(s) {
    if (typeof s !== "string") return { m: 0, e: 0 };
    const [ms, es] = s.split(",");
    const m = Number(ms);
    const e = Number(es);
    if (!isFinite(m) || !isFinite(e)) return { m: 0, e: 0 };
    return normalize(m, e);
  }

  function toSerialized(x) {
    return `${x.m},${x.e}`;
  }

  function cmp(a, b) {
    if (a.m === 0 && b.m === 0) return 0;
    if (a.m === 0) return -1;
    if (b.m === 0) return 1;
    if (a.e !== b.e) return a.e < b.e ? -1 : 1;
    return a.m < b.m ? -1 : a.m > b.m ? 1 : 0;
  }

  function gt(a, b) {
    return cmp(a, b) > 0;
  }
  function gte(a, b) {
    return cmp(a, b) >= 0;
  }
  function lt(a, b) {
    return cmp(a, b) < 0;
  }

  function add(a, b) {
    if (a.m === 0) return clone(b);
    if (b.m === 0) return clone(a);
    let m1 = a.m,
      e1 = a.e;
    let m2 = b.m,
      e2 = b.e;
    if (e1 < e2) {
      [m1, e1, m2, e2] = [m2, e2, m1, e1];
    }
    const diff = e1 - e2;
    if (diff > 16) return normalize(m1, e1);
    m2 *= Math.pow(10, -diff);
    return normalize(m1 + m2, e1);
  }

  function sub(a, b) {
    // Positive values only; expects a >= b for currency spends.
    if (b.m === 0) return clone(a);
    if (a.m === 0) return ZERO;
    if (cmp(a, b) < 0) return ZERO;
    let m1 = a.m,
      e1 = a.e;
    let m2 = b.m,
      e2 = b.e;
    if (e1 < e2) return ZERO;
    const diff = e1 - e2;
    if (diff > 16) return clone(a);
    m2 *= Math.pow(10, -diff);
    const nm = m1 - m2;
    if (nm <= 0) return ZERO;
    return normalize(nm, e1);
  }

  function mul(a, b) {
    if (a.m === 0 || b.m === 0) return { m: 0, e: 0 };
    return normalize(a.m * b.m, a.e + b.e);
  }

  function div(a, b) {
    if (a.m === 0) return { m: 0, e: 0 };
    if (b.m === 0) return { m: 0, e: 0 };
    return normalize(a.m / b.m, a.e - b.e);
  }

  function mulNum(a, n) {
    if (a.m === 0 || !isFinite(n) || n === 0) return { m: 0, e: 0 };
    return normalize(a.m * n, a.e);
  }

  /** b positive integer only (used for rough powers) */
  function powInt(a, b) {
    if (b === 0) return fromNumber(1);
    if (a.m === 0) return { m: 0, e: 0 };
    const log =
      b * (Math.log10(a.m) + a.e);
    if (log > 308) {
      // overflow guard: approximate in log space
      const le = Math.log10(a.m) + a.e;
      const ne = Math.floor(le * b);
      return normalize(Math.pow(10, le * b - ne), ne);
    }
    let v = fromNumber(1);
    let base = clone(a);
    let exp = b;
    while (exp > 0) {
      if (exp & 1) v = mul(v, base);
      base = mul(base, base);
      exp >>= 1;
    }
    return v;
  }

  function log10approx(x) {
    if (x.m === 0) return -Infinity;
    return Math.log10(x.m) + x.e;
  }

  /** Floor to JS safe integer when possible */
  function toNumberLossy(x) {
    const v = log10approx(x);
    if (v > 300) return Infinity;
    if (v < -300) return 0;
    return x.m * Math.pow(10, x.e);
  }

  function min2(a, b) {
    return lt(a, b) ? clone(a) : clone(b);
  }

  return {
    ZERO,
    clone,
    fromNumber,
    fromSerialized,
    toSerialized,
    add,
    sub,
    mul,
    div,
    mulNum,
    powInt,
    log10approx,
    toNumberLossy,
    min2,
    gt,
    gte,
    lt,
    cmp,
  };
})();

// =============================================================================
// Formatting — readable large numbers (K M B T Qa Qi … then scientific)
// =============================================================================

const SUFFIXES = [
  "",
  "K",
  "M",
  "B",
  "T",
  "Qa",
  "Qi",
  "Sx",
  "Sp",
  "Oc",
  "No",
  "Dc",
  "UDc",
  "DDc",
  "TDc",
  "QaDc",
  "QiDc",
  "SxDc",
  "SpDc",
];

function formatSci(x, decimals = 2) {
  if (x.m === 0) return "0";
  const log = SciNum.log10approx(x);
  if (log < 4) {
    const n = SciNum.toNumberLossy(x);
    if (n < 1) return n.toFixed(2);
    if (n < 10) return n.toFixed(2);
    if (n < 100) return n.toFixed(1);
    return String(Math.floor(n));
  }
  const idx = Math.floor(log / 3);
  if (idx >= SUFFIXES.length) {
    const exp = Math.floor(log);
    const mant = Math.pow(10, log - exp);
    return `${mant.toFixed(decimals)}e${exp}`;
  }
  const scale = idx * 3;
  const mant = Math.pow(10, log - scale);
  const d = mant.toFixed(decimals);
  return `${d} ${SUFFIXES[idx]}`.trim();
}

// Game configuration — balance knobs
// =============================================================================

const SAVE_VERSION = 4;
const TICK_MS = 100;
const OFFLINE_CAP_S = 48 * 3600;
/** Minimum saved format we still migrate from */
const MIN_SAVE_VERSION = 3;

/** Unlock purchase at current run Order ≥ this value */
const AUTO_CLICKER_ORDER_REQUIREMENT = 15;
/** One pulse per interval = one manual click worth of Energy */
const AUTO_CLICKER_INTERVAL_MS = 1000;
/** One-time purchase cost */
const AUTO_CLICKER_COST = SciNum.fromNumber(5e17);
/** First Ascension gate (~1e6); after that use getAscendRequirement() */
const ASCEND_FIRST_LOG = 6;
const ORDER_ROMAN = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
];

function orderRoman(n) {
  if (n <= 0) return "I";
  if (n <= ORDER_ROMAN.length) return ORDER_ROMAN[n - 1];
  return `XII +${n - 12}`;
}

/** Order scaling: tiers 1–4 stay strong; deep tiers taper so late climb is long but fair */
function dimGrowth(t, base = 1) {
  const past = Math.max(0, t - 4);
  return base / (1 + 0.025 * Math.max(0, t - 1) + 0.012 * past * past);
}

/** Each run starts fast (minutes of bonus production), then settles — hook for “one more reset”. */
function getNewRunMomentum() {
  const t = state.runTimeMs;
  const tau = 11 * 60 * 1000; // ~11 minute decay
  return 1 + 1.25 * Math.exp(-t / tau);
}

/**
 * Ascension Energy floor rises with completions so prestige never becomes trivial,
 * but the first runs stay snappy (starts near 1e6).
 */
function getAscendRequirement() {
  const a = state.ascensions;
  const logReq =
    ASCEND_FIRST_LOG +
    1.05 * Math.log10(1 + a) ** 1.45 +
    0.12 * Math.max(0, a - 6) +
    0.35 * Math.max(0, a - 28);
  const e = Math.floor(logReq);
  const m = Math.pow(10, logReq - e);
  return { m, e };
}

// =============================================================================
// Upgrade definitions (data-driven shop)
// =============================================================================

/**
 * costFn(level) => SciNum
 * effect described in applyUpgrade
 */
const UPGRADES = {
  click_power: {
    id: "click_power",
    name: "Focus Training",
    desc: "Sharpen each click — strong first 25 levels, steady after (two-phase scaling).",
    baseCost: SciNum.fromNumber(12),
    growth: 1.125,
    tierReq: 1,
    type: "basic",
    icon: "◇",
  },
  passive_base: {
    id: "passive_base",
    name: "Radiant Collector",
    desc: "Passive lattice: generous early /s, soft-capped at extreme levels.",
    baseCost: SciNum.fromNumber(18),
    growth: 1.118,
    tierReq: 1,
    type: "basic",
    icon: "✧",
  },
  passive_pct: {
    id: "passive_pct",
    name: "Harmonic Resonance",
    desc: "+11% passive / level (early), slightly softer past level 40.",
    baseCost: SciNum.fromNumber(55),
    growth: 1.152,
    tierReq: 1,
    type: "basic",
    icon: "〰",
  },
  global_mult: {
    id: "global_mult",
    name: "Universal Constant",
    desc: "+4.5% all Energy / level — soft diminishing past level ~35 (infinite depth).",
    baseCost: SciNum.fromNumber(240),
    growth: 1.175,
    tierReq: 2,
    type: "advanced",
    icon: "✶",
  },
  auto_pulses: {
    id: "auto_pulses",
    name: "Pulse Automaton",
    desc: "Auto pulses: 0.85 /s per level (scales with click power).",
    baseCost: SciNum.fromNumber(750),
    growth: 1.235,
    tierReq: 3,
    type: "advanced",
    icon: "⚙",
  },
  overclock: {
    id: "overclock",
    name: "Temporal Overclock",
    desc: "Passive tick efficiency — stronger early, diminishing past high levels.",
    baseCost: SciNum.fromNumber(4200),
    growth: 1.255,
    tierReq: 4,
    type: "advanced",
    icon: "⏱",
  },
};

const ESSENCE_UPGRADES = {
  everlight: {
    id: "everlight",
    name: "Everlight",
    desc: "Permanent +12% all Energy — your long-term backbone.",
    baseCost: 1,
    growth: 1.48,
    reqAscensions: 0,
  },
  essence_gain: {
    id: "essence_gain",
    name: "Returning Echo",
    desc: "+10% Essence from each Ascension (stacking returns).",
    baseCost: 2,
    growth: 1.58,
    reqAscensions: 1,
  },
  star_born: {
    id: "star_born",
    name: "Star-Born Will",
    desc: "+0.12 autoclick weight / level (scales pulses into deep runs).",
    baseCost: 4,
    growth: 1.62,
    reqAscensions: 2,
  },
  covenant: {
    id: "covenant",
    name: "Covenant of Orders",
    desc: "Order multipliers +3.5% stronger / level.",
    baseCost: 10,
    growth: 1.78,
    reqAscensions: 4,
  },
};

// =============================================================================
// Mutable state (run + meta)
// =============================================================================

const state = {
  energy: SciNum.fromNumber(0),
  /** Lifetime energy for stats/achievements */
  totalEnergy: SciNum.fromNumber(0),
  /** Energy gained this run (for essence calc) */
  runEnergy: SciNum.fromNumber(0),
  /** Peak energy this run */
  runPeak: SciNum.fromNumber(0),

  order: 1,
  /** max order reached ever */
  highestOrder: 1,

  levels: Object.fromEntries(
    Object.keys(UPGRADES).map((k) => [k, 0])
  ),
  essenceLevels: Object.fromEntries(
    Object.keys(ESSENCE_UPGRADES).map((k) => [k, 0])
  ),

  essence: 0,
  ascensions: 0,

  achievements: /** @type {Record<string, boolean>} */ ({}),

  lastSave: Date.now(),
  offlineModalPending: false,
  offlineGains: null,

  playTimeMs: 0,
  /** Resets on Ascend — powers getNewRunMomentum() for snappy early run */
  runTimeMs: 0,

  /** One-time buy once current Order ≥ XV; persists across Ascension */
  autoClickerPurchased: false,
  /** User-controlled; survives Ascension */
  autoClickerActive: false,
};

// Autosave / dirty flag
let saveDirty = false;

// =============================================================================
// Economy: derive multipliers & costs
// =============================================================================

function getOrderMult() {
  const o = state.order;
  const base = 1 + 0.158 * (o - 1) + 0.004 * Math.max(0, o - 7) * (o - 7);
  const covenant = state.essenceLevels.covenant || 0;
  const boosted = base * (1 + 0.035 * covenant);
  const slow = dimGrowth(o, 1);
  return boosted * slow;
}

function getEssenceMult() {
  const lv = state.essenceLevels.everlight || 0;
  return Math.pow(1.12, lv);
}

function getGlobalMultFromUpgrades() {
  const lv = state.levels.global_mult || 0;
  if (lv <= 0) return 1;
  const raw = 1 + 0.045 * lv;
  const dim = 1 / (1 + 0.028 * Math.max(0, lv - 35));
  return raw * dim;
}

function getOverclockMult() {
  const lv = state.levels.overclock || 0;
  if (lv <= 0) return 1;
  const mk = 1 + 0.16 * lv;
  const late = 1 / (1 + 0.006 * Math.max(0, lv - 55) ** 1.15);
  return (1 + (mk - 1) / (1 + 0.009 * lv * lv)) * late;
}

function clickPowerFactor(level) {
  const early = Math.min(level, 28);
  const late = Math.max(0, level - 28);
  return Math.pow(1.23, early) * Math.pow(1.115, late);
}

function energyPerClick() {
  const lvClick = state.levels.click_power || 0;
  const clickFactor = clickPowerFactor(lvClick);
  const momentum = getNewRunMomentum();
  const order = getOrderMult();
  const essence = getEssenceMult();
  const globalU = getGlobalMultFromUpgrades();
  const base = 1;
  const n = base * clickFactor * momentum * order * essence * globalU;
  return SciNum.fromNumber(n);
}

function passiveBasePerSec() {
  const lv = state.levels.passive_base || 0;
  if (lv <= 0) return 0;
  const eff = lv / (1 + lv / 110);
  return 0.92 * eff;
}

function passivePctMult() {
  const lv = state.levels.passive_pct || 0;
  const soft = 1 / (1 + 0.0018 * Math.max(0, lv - 48) ** 1.1);
  return Math.pow(1.11, lv) * soft;
}

function autoClicksPerSec() {
  const lv = state.levels.auto_pulses || 0;
  const starBorn = state.essenceLevels.star_born || 0;
  const w = 0.85 * lv * (1 + 0.12 * starBorn);
  return w;
}

function energyPerSecond() {
  const raw = passiveBasePerSec() * passivePctMult();
  if (raw <= 0) return SciNum.fromNumber(0);
  const momentum = getNewRunMomentum();
  let n =
    raw *
    momentum *
    getOrderMult() *
    getEssenceMult() *
    getGlobalMultFromUpgrades() *
    getOverclockMult();
  // Late Order soft pressure (moved upward so mid-game is not punished)
  n /= 1 + 0.000045 * Math.max(0, state.order - 12) ** 2;
  return SciNum.fromNumber(n);
}

function upgradeCostFixed(id) {
  const def = UPGRADES[id];
  const lv = state.levels[id] || 0;
  const lateStretch =
    1 +
    0.0042 * Math.max(0, lv - 40) +
    0.00011 * Math.max(0, lv - 115) ** 2;
  const growth = def.growth * lateStretch;
  const n = SciNum.toNumberLossy(def.baseCost) * Math.pow(growth, lv);
  if (!isFinite(n) || n > 1e300) {
    const lc =
      SciNum.log10approx(def.baseCost) + lv * Math.log10(growth);
    const e = Math.floor(lc);
    const m = Math.pow(10, lc - e);
    return { m, e };
  }
  return SciNum.fromNumber(n);
}

function essenceUpgradeCost(id) {
  const def = ESSENCE_UPGRADES[id];
  const lv = state.essenceLevels[id] || 0;
  const deepTax =
    1 + 0.055 * Math.max(0, lv - 14) ** 1.32 + 0.002 * Math.max(0, lv - 55) ** 2;
  return Math.ceil(def.baseCost * deepTax * Math.pow(def.growth, lv));
}

function orderAdvanceCost() {
  const o = state.order;
  const earlyEase = Math.max(0, 5 - o) * 0.28;
  const log =
    2.55 +
    o * 1.32 +
    Math.pow(Math.max(0, o - 5), 1.38) * 0.14 -
    earlyEase;
  const e = Math.floor(log);
  const m = Math.pow(10, log - e);
  return { m, e };
}

function canAscend() {
  return SciNum.gte(state.energy, getAscendRequirement());
}

function pendingEssenceGain() {
  if (!canAscend()) return 0;
  const le = SciNum.log10approx(state.energy);
  const lt = SciNum.log10approx(state.totalEnergy);
  const ordL = Math.log10(Math.max(1, state.order));
  const essenceGainLv = state.essenceLevels.essence_gain || 0;
  const a = state.ascensions;
  const ascBonus =
    (1 + 0.05 * a) * (1 + 0.022 * Math.max(0, a - 12) * Math.log10(1 + a));
  const echo = Math.pow(1.1, essenceGainLv);
  // No artificial Essence cap — log domain capped to avoid Infinity (~308)
  const inner = le * 0.5 + lt * 0.1 + ordL * 0.58 - 3.4;
  const exp = Math.min(308, Math.max(0, inner));
  let gain = Math.pow(10, exp) * ascBonus * echo;
  if (!isFinite(gain) || gain > Number.MAX_SAFE_INTEGER) {
    gain = Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor(gain));
}

// =============================================================================
// Achievements
// =============================================================================

const ACHIEVEMENTS = [
  { id: "e1k", name: "Spark", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e3)) },
  { id: "e1m", name: "Bonfire", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e6)) },
  { id: "e1b", name: "Nova", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e9)) },
  { id: "e1t", name: "Stellar River", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e12)) },
  { id: "e1qa", name: "Galactic Drift", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e15)) },
  { id: "e1qi", name: "Cosmic Tide", test: () => SciNum.gte(state.totalEnergy, SciNum.fromNumber(1e18)) },
  { id: "order3", name: "Trinity Path", test: () => state.highestOrder >= 3 },
  { id: "order6", name: "Hex Foundation", test: () => state.highestOrder >= 6 },
  { id: "order10", name: "Decachord", test: () => state.highestOrder >= 10 },
  { id: "asc1", name: "First Dawn", test: () => state.ascensions >= 1 },
  { id: "asc5", name: "Many Returns", test: () => state.ascensions >= 5 },
  { id: "asc15", name: "Fifteenth Sun", test: () => state.ascensions >= 15 },
  { id: "asc40", name: "Architect of Cycles", test: () => state.ascensions >= 40 },
  { id: "ess10", name: "Essence Hoard", test: () => state.essence >= 10 },
  { id: "ess1k", name: "River of Light", test: () => state.essence >= 1000 },
  { id: "auto", name: "Hands Free", test: () => (state.levels.auto_pulses || 0) >= 1 },
  { id: "time1h", name: "Patient Star", test: () => state.playTimeMs >= 3600000 },
];

function checkAchievements() {
  let any = false;
  for (const a of ACHIEVEMENTS) {
    if (state.achievements[a.id]) continue;
    if (a.test()) {
      state.achievements[a.id] = true;
      any = true;
    }
  }
  if (any) achDirty = true;
  return any;
}

// =============================================================================
// Actions: click, buy, ascend, order
// =============================================================================

function addEnergy(amt) {
  state.energy = SciNum.add(state.energy, amt);
  state.totalEnergy = SciNum.add(state.totalEnergy, amt);
  state.runEnergy = SciNum.add(state.runEnergy, amt);
  if (SciNum.gt(amt, SciNum.ZERO)) {
    if (SciNum.gt(state.energy, state.runPeak)) {
      state.runPeak = SciNum.clone(state.energy);
    }
  }
  saveDirty = true;
}

function spendEnergy(amt) {
  if (SciNum.lt(state.energy, amt)) return false;
  state.energy = SciNum.sub(state.energy, amt);
  saveDirty = true;
  return true;
}

function onStarClick(event) {
  const epc = energyPerClick();
  addEnergy(epc);
  checkAchievements();
  spawnFloatText(event, `+${formatSci(epc, 2)}`);
  pulseStar();
  renderTopBar();
  renderBars();
}

function pulseStar() {
  const btn = document.getElementById("star-btn");
  if (!btn) return;
  btn.classList.remove("star-btn--pop");
  void btn.offsetWidth;
  btn.classList.add("star-btn--pop");
}

function spawnFloatText(event, text) {
  const layer = document.getElementById("float-layer");
  if (!layer) return;
  const el = document.createElement("div");
  el.className = "float-num";
  el.textContent = text;
  const cx = event.clientX ?? window.innerWidth / 2;
  const cy = event.clientY ?? window.innerHeight / 3;
  el.style.left = `${cx + (Math.random() * 40 - 20)}px`;
  el.style.top = `${cy + (Math.random() * 20 - 10)}px`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

function buyUpgrade(id) {
  const def = UPGRADES[id];
  if (state.order < def.tierReq) return;
  const cost = upgradeCostFixed(id);
  if (!spendEnergy(cost)) return;
  state.levels[id] = (state.levels[id] || 0) + 1;
  shopDirty = true;
  saveDirty = true;
}

function buyEssenceUpgrade(id) {
  const def = ESSENCE_UPGRADES[id];
  if (state.ascensions < def.reqAscensions) return;
  const cost = essenceUpgradeCost(id);
  if (state.essence < cost) return;
  state.essence -= cost;
  state.essenceLevels[id] = (state.essenceLevels[id] || 0) + 1;
  shopDirty = true;
  saveDirty = true;
}

function tryAdvanceOrder() {
  const cost = orderAdvanceCost();
  if (!spendEnergy(cost)) return;
  state.order += 1;
  state.highestOrder = Math.max(state.highestOrder, state.order);
  shopDirty = true;
  saveDirty = true;
}

function ascend() {
  if (!canAscend()) return;
  const gain = pendingEssenceGain();
  state.essence += gain;
  state.ascensions += 1;

  // Reset run
  state.energy = SciNum.fromNumber(0);
  state.order = 1;
  state.runEnergy = SciNum.fromNumber(0);
  state.runPeak = SciNum.fromNumber(0);
  state.runTimeMs = 0;
  for (const k of Object.keys(state.levels)) state.levels[k] = 0;

  saveDirty = true;
  checkAchievements();
}

// =============================================================================
// Order Auto-Clicker — purchase at Order XV, setInterval tick (never stacked)
// =============================================================================

let autoClickerTimerId = null;

function stopAutoClickerInterval() {
  if (autoClickerTimerId !== null) {
    clearInterval(autoClickerTimerId);
    autoClickerTimerId = null;
  }
}

function tickAutoClicker() {
  if (!state.autoClickerPurchased || !state.autoClickerActive) return;
  const epc = energyPerClick();
  if (SciNum.gt(epc, SciNum.ZERO)) {
    addEnergy(epc);
    checkAchievements();
  }
}

/** Clears any prior timer, then starts at most one interval if purchased & active */
function syncAutoClickerIntervalFromState() {
  stopAutoClickerInterval();
  if (state.autoClickerPurchased && state.autoClickerActive) {
    autoClickerTimerId = setInterval(tickAutoClicker, AUTO_CLICKER_INTERVAL_MS);
  }
}

function purchaseAutoClicker() {
  if (state.autoClickerPurchased) return;
  if (state.order < AUTO_CLICKER_ORDER_REQUIREMENT) return;
  if (!SciNum.gte(state.energy, AUTO_CLICKER_COST)) return;
  if (!spendEnergy(AUTO_CLICKER_COST)) return;
  state.autoClickerPurchased = true;
  saveDirty = true;
}

function setAutoClickerActive(on) {
  if (!state.autoClickerPurchased) return;
  const next = !!on;
  if (state.autoClickerActive !== next) {
    state.autoClickerActive = next;
    saveDirty = true;
  }
  syncAutoClickerIntervalFromState();
}

function toggleAutoClicker() {
  setAutoClickerActive(!state.autoClickerActive);
}

// =============================================================================
// Persistence
// =============================================================================

const LS_KEY = "starlight_idle_save_v1";

function serialize() {
  return JSON.stringify({
    v: SAVE_VERSION,
    energy: SciNum.toSerialized(state.energy),
    totalEnergy: SciNum.toSerialized(state.totalEnergy),
    runEnergy: SciNum.toSerialized(state.runEnergy),
    runPeak: SciNum.toSerialized(state.runPeak),
    order: state.order,
    highestOrder: state.highestOrder,
    levels: state.levels,
    essenceLevels: state.essenceLevels,
    essence: state.essence,
    ascensions: state.ascensions,
    achievements: state.achievements,
    lastSave: Date.now(),
    playTimeMs: state.playTimeMs,
    runTimeMs: state.runTimeMs,
    autoClickerPurchased: state.autoClickerPurchased,
    autoClickerActive: state.autoClickerActive,
  });
}

function deserialize(str) {
  try {
    const raw = JSON.parse(str);
    if (!raw || raw.v < MIN_SAVE_VERSION || raw.v > SAVE_VERSION) return false;
    state.energy = SciNum.fromSerialized(raw.energy);
    state.totalEnergy = SciNum.fromSerialized(raw.totalEnergy);
    state.runEnergy = SciNum.fromSerialized(raw.runEnergy);
    state.runPeak = SciNum.fromSerialized(raw.runPeak);
    state.order = raw.order | 0 || 1;
    state.highestOrder = raw.highestOrder | 0 || state.order;
    state.levels = { ...state.levels, ...raw.levels };
    state.essenceLevels = { ...state.essenceLevels, ...raw.essenceLevels };
    state.essence = raw.essence | 0;
    state.ascensions = raw.ascensions | 0;
    state.achievements = { ...state.achievements, ...raw.achievements };
    state.lastSave = raw.lastSave || Date.now();
    state.playTimeMs = raw.playTimeMs | 0;
    state.runTimeMs = raw.runTimeMs | 0;
    state.autoClickerPurchased = Boolean(raw.autoClickerPurchased);
    state.autoClickerActive = Boolean(raw.autoClickerActive);
    return true;
  } catch {
    return false;
  }
}

function save() {
  try {
    localStorage.setItem(LS_KEY, serialize());
    const ind = document.getElementById("save-indicator");
    if (ind) {
      ind.classList.add("is-live");
      setTimeout(() => ind.classList.remove("is-live"), 500);
    }
  } catch {
    /* ignore quota */
  }
}

function load() {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) deserialize(s);
  } catch {
    /* ignore */
  }
}

function wipeSave() {
  if (!confirm("Delete all local progress? This cannot be undone.")) return;
  localStorage.removeItem(LS_KEY);
  location.reload();
}

/** Apply passive income accrued while away (capped). */
function applyOfflineProgress(now) {
  const last = state.lastSave || now;
  const deltaMs = Math.max(0, now - last);
  const deltaS = Math.min(OFFLINE_CAP_S, deltaMs / 1000);
  if (deltaS < 10) return;

  const eps = energyPerSecond();
  const gainedFixed = SciNum.mulNum(eps, deltaS);

  if (SciNum.gt(gainedFixed, SciNum.fromNumber(0.0001))) {
    addEnergy(gainedFixed);
    state.offlineModalPending = true;
    state.offlineGains = {
      seconds: deltaS,
      amount: gainedFixed,
      eps: eps,
    };
  }
}

// =============================================================================
// UI rendering (called from rAF, throttled internally)
// =============================================================================

let lastUiEnergyStr = "";

function renderTopBar() {
  const ed = document.getElementById("energy-display");
  const epsd = document.getElementById("eps-display");
  const epc = document.getElementById("epc-display");
  const ess = document.getElementById("essence-display");
  const ord = document.getElementById("order-display");
  const app = document.getElementById("app");

  const estr = formatSci(state.energy, 3);
  if (estr !== lastUiEnergyStr) {
    ed.textContent = estr;
    lastUiEnergyStr = estr;
  }
  epsd.textContent = `+${formatSci(energyPerSecond(), 2)} /s`;
  epc.textContent = `+${formatSci(energyPerClick(), 2)} /click`;
  ess.textContent = String(Math.floor(state.essence));
  ord.textContent = orderRoman(state.order);
  app.dataset.tier = String(Math.min(12, state.order));

  const momLine = document.getElementById("momentum-line");
  if (momLine) {
    const m = getNewRunMomentum();
    if (m > 1.015) {
      momLine.hidden = false;
      momLine.textContent = `Run momentum ×${m.toFixed(
        2
      )} (boosts click & passive — decays over ~12 min after Ascend)`;
    } else {
      momLine.hidden = true;
    }
  }
}

function renderAutoClickerPanel() {
  const block = document.getElementById("auto-clicker-block");
  const lockedEl = document.getElementById("auto-clicker-locked");
  const buyEl = document.getElementById("auto-clicker-buy");
  const controlsEl = document.getElementById("auto-clicker-controls");
  const statusEl = document.getElementById("auto-clicker-status");
  const toggleBtn = document.getElementById("auto-clicker-toggle");
  const purchaseBtn = document.getElementById("auto-clicker-purchase-btn");
  const purchaseMeta = document.getElementById("auto-clicker-purchase-meta");
  if (
    !block ||
    !lockedEl ||
    !buyEl ||
    !controlsEl ||
    !statusEl ||
    !toggleBtn ||
    !purchaseBtn ||
    !purchaseMeta
  ) {
    return;
  }

  const purchased = state.autoClickerPurchased;
  const canBuyNow = state.order >= AUTO_CLICKER_ORDER_REQUIREMENT;

  if (purchased) {
    lockedEl.hidden = true;
    buyEl.hidden = true;
    controlsEl.hidden = false;
    const on = state.autoClickerActive;
    statusEl.textContent = on
      ? `ON — +1 click every ${AUTO_CLICKER_INTERVAL_MS / 1000}s (uses current click power; works in background).`
      : "OFF — auto-clicks are stopped.";
    toggleBtn.textContent = on ? "Turn OFF" : "Turn ON";
    toggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    toggleBtn.classList.toggle("auto-clicker__toggle--on", on);
    return;
  }

  controlsEl.hidden = true;

  if (canBuyNow) {
    lockedEl.hidden = true;
    buyEl.hidden = false;
    purchaseMeta.textContent = `One-time cost: ${formatSci(
      AUTO_CLICKER_COST,
      2
    )} Energy.`;
    purchaseBtn.disabled = !SciNum.gte(state.energy, AUTO_CLICKER_COST);
  } else {
    lockedEl.hidden = false;
    buyEl.hidden = true;
  }
}

function renderShop() {
  const basic = document.getElementById("shop-basic");
  const adv = document.getElementById("shop-advanced");
  if (!basic || !adv) return;
  basic.innerHTML = "";
  adv.innerHTML = "";

  for (const id of Object.keys(UPGRADES)) {
    const def = UPGRADES[id];
    const wrap = document.createElement("div");
    wrap.dataset.upgradeId = id;
    wrap.className = "upgrade-card";
    if (state.order < def.tierReq) {
      wrap.classList.add("is-locked");
    }
    if (!canAffordUpgrade(id)) wrap.classList.add("is-disabled");

    const title = document.createElement("div");
    title.className = "upgrade-card__title";
    title.textContent = `${def.icon} ${def.name} (Lv ${state.levels[id] || 0})`;

    const desc = document.createElement("div");
    desc.className = "upgrade-card__desc";
    desc.textContent = def.desc;

    const meta = document.createElement("div");
    meta.className = "upgrade-card__meta";
    meta.textContent =
      state.order < def.tierReq
        ? `Unlock at Order ${orderRoman(def.tierReq)}`
        : `Cost: ${formatSci(upgradeCostFixed(id), 2)}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--primary btn--buy";
    btn.textContent = "Buy";
    btn.disabled = state.order < def.tierReq || !canAffordUpgrade(id);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      buyUpgrade(id);
    });
    wrap.append(title, desc, meta, btn);
    (def.type === "basic" ? basic : adv).appendChild(wrap);
  }
}

/** Lightweight sync — avoids full DOM rebuild while Energy ticks (fixes shop flicker). */
function refreshEnergyShopCards() {
  const panelShop = document.getElementById("panel-shop");
  if (panelShop?.hidden) return;

  const basic = document.getElementById("shop-basic");
  const adv = document.getElementById("shop-advanced");
  if (!basic || !adv) return;
  if (basic.childElementCount === 0 && adv.childElementCount === 0) return;

  for (const grid of [basic, adv]) {
    for (const wrap of grid.children) {
      const id = wrap.dataset.upgradeId;
      const def = id && UPGRADES[id];
      if (!def) continue;

      const tierOk = state.order >= def.tierReq;
      const afford = canAffordUpgrade(id);
      const locked = !tierOk;
      const disabled = !tierOk || !afford;
      const metaStr = !tierOk
        ? `Unlock at Order ${orderRoman(def.tierReq)}`
        : `Cost: ${formatSci(upgradeCostFixed(id), 2)}`;

      if (locked !== wrap.classList.contains("is-locked")) {
        wrap.classList.toggle("is-locked", locked);
      }
      if (wrap.classList.contains("is-disabled") !== !afford) {
        wrap.classList.toggle("is-disabled", !afford);
      }
      const btn = wrap.querySelector("button.btn--buy");
      if (btn && btn.disabled !== disabled) btn.disabled = disabled;

      const meta = wrap.querySelector(".upgrade-card__meta");
      if (meta && meta.textContent !== metaStr) meta.textContent = metaStr;
    }
  }
}

function canAffordUpgrade(id) {
  return SciNum.gte(state.energy, upgradeCostFixed(id));
}

function renderMetaShop() {
  const root = document.getElementById("shop-meta");
  if (!root) return;
  root.innerHTML = "";
  for (const id of Object.keys(ESSENCE_UPGRADES)) {
    const def = ESSENCE_UPGRADES[id];
    const card = document.createElement("div");
    card.className = "upgrade-card";
    const lv = state.essenceLevels[id] || 0;
    const cost = essenceUpgradeCost(id);
    const locked = state.ascensions < def.reqAscensions;
    if (locked) card.classList.add("is-locked");

    const title = document.createElement("div");
    title.className = "upgrade-card__title";
    title.textContent = `${def.name} (Lv ${lv})`;
    const desc = document.createElement("div");
    desc.className = "upgrade-card__desc";
    desc.textContent = def.desc;
    const meta = document.createElement("div");
    meta.className = "upgrade-card__meta";
    meta.textContent = locked
      ? `Requires ${def.reqAscensions}+ Ascension(s)`
      : `Cost: ${cost} Essence`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--accent btn--buy";
    btn.textContent = "Infuse";
    btn.disabled = locked || state.essence < cost;
    btn.addEventListener("click", () => buyEssenceUpgrade(id));
    card.append(title, desc, meta, btn);
    root.appendChild(card);
  }
}

function renderOrderPanel() {
  const nextCost = orderAdvanceCost();
  const costSN = { m: nextCost.m, e: nextCost.e };
  const mult = getOrderMult();
  document.getElementById("order-detail-tier").textContent = orderRoman(state.order);
  document.getElementById("order-detail-mult").textContent = `×${mult.toFixed(3)}`;
  document.getElementById("order-detail-req").textContent = formatSci(costSN, 2);
  const btn = document.getElementById("order-advance-btn");
  btn.disabled = !SciNum.gte(state.energy, costSN);
  const hint = document.getElementById("order-advance-hint");
  hint.textContent = SciNum.gte(state.energy, costSN)
    ? "Ready when you are — advancing raises tier multiplier but steepens the climb."
    : `Need ${formatSci(costSN, 2)} Energy to advance.`;
}

function renderAscendPanel() {
  const gainEl = document.getElementById("ascend-gain-text");
  const gain = pendingEssenceGain();
  gainEl.innerHTML = `You would gain <strong>${gain}</strong> Essence.`;
  const btn = document.getElementById("ascend-btn");
  const ok = canAscend();
  btn.disabled = !ok;
  const why = document.getElementById("ascend-block-reason");
  const need = getAscendRequirement();
  why.textContent = ok
    ? "You meet this run’s Energy floor — Ascend to bank Essence and start a faster opening (new-run momentum)."
    : `Current floor: ${formatSci(
        need,
        2
      )} Energy. Rises with each Ascension so resets stay meaningful for days, not minutes.`;
}

function renderStats() {
  const grid = document.getElementById("stats-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const rows = [
    ["Total Energy (all time)", formatSci(state.totalEnergy, 2)],
    ["Ascensions", String(state.ascensions)],
    ["Essence", String(state.essence)],
    ["Highest Order reached", orderRoman(state.highestOrder)],
    ["Play time", `${(state.playTimeMs / 3600000).toFixed(2)} h`],
    ["Energy this run", formatSci(state.runEnergy, 2)],
    ["Peak Energy (this run)", formatSci(state.runPeak, 2)],
    [
      "Time this run",
      `${(state.runTimeMs / 60000).toFixed(1)} min (momentum fades over ~10–12 min)`,
    ],
    [
      "Order Auto-Clicker",
      state.autoClickerPurchased
        ? state.autoClickerActive
          ? `Owned — ON (${AUTO_CLICKER_INTERVAL_MS / 1000}s)`
          : "Owned — OFF"
        : "Not purchased",
    ],
  ];
  for (const [k, v] of rows) {
    const box = document.createElement("div");
    box.className = "stat-box";
    box.innerHTML = `${k}<strong>${v}</strong>`;
    grid.appendChild(box);
  }
}

function renderAchievements() {
  const list = document.getElementById("achievements-list");
  if (!list) return;
  list.innerHTML = "";
  for (const a of ACHIEVEMENTS) {
    const row = document.createElement("div");
    row.className = "ach-row" + (state.achievements[a.id] ? " is-done" : "");
    row.innerHTML = `<span>${a.name}</span><span class="ach-badge">${
      state.achievements[a.id] ? "Unlocked" : "Locked"
    }</span>`;
    list.appendChild(row);
  }
}

function renderBars() {
  const nextOrderCost = orderAdvanceCost();
  const oSnap = { m: nextOrderCost.m, e: nextOrderCost.e };
  const p = SciNum.gt(oSnap, SciNum.ZERO)
    ? Math.min(1, SciNum.toNumberLossy(SciNum.div(state.energy, oSnap)))
    : 0;
  const fill = document.getElementById("order-progress-fill");
  const txt = document.getElementById("order-progress-text");
  if (fill) fill.style.width = `${(p * 100).toFixed(1)}%`;
  if (txt) txt.textContent = `${formatSci(state.energy, 2)} / ${formatSci(oSnap, 2)} toward next Order`;

  const needAsc = getAscendRequirement();
  const ap = canAscend()
    ? 1
    : Math.min(
        1,
        SciNum.log10approx(state.energy) / SciNum.log10approx(needAsc)
      );
  const af = document.getElementById("ascend-preview-fill");
  const at = document.getElementById("ascend-preview-text");
  if (af) af.style.width = `${(ap * 100).toFixed(1)}%`;
  if (at)
    at.textContent = canAscend()
      ? "Ascension available — see Ascend tab."
      : `${(ap * 100).toFixed(0)}% toward Ascension gate`;
}

let shopDirty = true;
let achDirty = true;

function renderFullShopAndPanels() {
  shopDirty = true;
}

function renderUnlockTabs() {
  const te = SciNum.toNumberLossy(state.totalEnergy);
  for (const tab of document.querySelectorAll(".tab[data-unlock-energy]")) {
    const need = Number(tab.dataset.unlockEnergy);
    if (te >= need) {
      tab.classList.remove("is-locked");
      tab.removeAttribute("aria-disabled");
    }
  }
  for (const tab of document.querySelectorAll(".tab[data-unlock-ascensions]")) {
    const need = Number(tab.dataset.unlockAscensions);
    if (state.ascensions >= need) {
      tab.classList.remove("is-locked");
      tab.removeAttribute("aria-disabled");
    }
  }
  for (const tab of document.querySelectorAll(".tab[data-unlock-total-energy]")) {
    const need = Number(tab.dataset.unlockTotalEnergy);
    if (te >= need) {
      tab.classList.remove("is-locked");
      tab.removeAttribute("aria-disabled");
    }
  }
}

// =============================================================================
// Tabs
// =============================================================================

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  function show(id) {
    for (const p of panels) {
      const match = p.dataset.panel === id;
      p.toggleAttribute("hidden", !match);
      p.classList.toggle("panel--active", match);
    }
    for (const t of tabs) {
      const on = t.dataset.tab === id;
      t.classList.toggle("tab--active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  for (const t of tabs) {
    t.addEventListener("click", () => {
      if (t.classList.contains("is-locked")) return;
      show(t.dataset.tab);
      if (t.dataset.tab === "shop" || t.dataset.tab === "meta") shopDirty = true;
    });
  }
}

// =============================================================================
// Main loop — rAF + fixed timestep accumulator
// =============================================================================

let lastFrame = performance.now();
let acc = 0;

function tickGame(dtMs) {
  state.playTimeMs += dtMs;
  state.runTimeMs += dtMs;
  const secs = dtMs / 1000;
  const eps = energyPerSecond();
  const aps = autoClicksPerSec();
  const epc = energyPerClick();

  if (SciNum.gt(eps, SciNum.ZERO)) {
    addEnergy(SciNum.mulNum(eps, secs));
  }
  if (aps > 0) {
    addEnergy(SciNum.mulNum(epc, aps * secs));
  }

  checkAchievements();

  if (saveDirty) {
    state.lastSave = Date.now();
    save();
    saveDirty = false;
  }
}

function frame(now) {
  try {
    const dt = Math.min(250, now - lastFrame);
    lastFrame = now;
    acc += dt;
    while (acc >= TICK_MS) {
      tickGame(TICK_MS);
      acc -= TICK_MS;
    }

    renderTopBar();
    renderBars();
    renderAutoClickerPanel();
    renderUnlockTabs();
    if (shopDirty) {
      renderShop();
      renderMetaShop();
      shopDirty = false;
    }
    refreshEnergyShopCards();
    if (achDirty) {
      renderAchievements();
      achDirty = false;
    }
    renderOrderPanel();
    renderAscendPanel();
    renderStats();
  } catch (err) {
    console.error("[Starlight Idle] frame:", err);
  }

  requestAnimationFrame(frame);
}

// =============================================================================
// Boot
// =============================================================================

function showOfflineModal() {
  if (!state.offlineModalPending || !state.offlineGains) return;
  const dlg = document.getElementById("offline-modal");
  const txt = document.getElementById("offline-summary");
  const g = state.offlineGains;
  txt.innerHTML = `Time simulated: <strong>${(g.seconds / 3600).toFixed(2)}</strong> hours (capped at 48h).<br/>
    Estimated gain: <strong>${formatSci(g.amount, 2)}</strong> Energy<br/>
    Based on current passive rate; upgrades apply now.`;
  dlg.showModal();
}

function onOfflineDismiss() {
  const dlg = document.getElementById("offline-modal");
  dlg.close();
  state.offlineModalPending = false;
  state.offlineGains = null;
}

function bindUi() {
  document.getElementById("star-btn").addEventListener("click", onStarClick);
  document.getElementById("offline-dismiss").addEventListener("click", onOfflineDismiss);
  document.getElementById("wipe-save").addEventListener("click", wipeSave);
  document.getElementById("order-advance-btn").addEventListener("click", () => tryAdvanceOrder());
  document.getElementById("ascend-btn").addEventListener("click", () => {
    ascend();
    renderFullShopAndPanels();
  });

  document.getElementById("auto-clicker-purchase-btn").addEventListener("click", () => {
    purchaseAutoClicker();
    renderAutoClickerPanel();
  });
  document.getElementById("auto-clicker-toggle").addEventListener("click", () => {
    toggleAutoClicker();
    renderAutoClickerPanel();
  });

  // Periodic autosave
  setInterval(() => {
    saveDirty = true;
  }, 5000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      state.lastSave = Date.now();
      save();
    }
  });
}

function boot() {
  load();
  const now = Date.now();
  applyOfflineProgress(now);
  state.lastSave = now;

  bindUi();
  setupTabs();

  syncAutoClickerIntervalFromState();

  renderTopBar();
  renderAutoClickerPanel();
  renderFullShopAndPanels();
  requestAnimationFrame(frame);

  setTimeout(showOfflineModal, 200);
}

boot();