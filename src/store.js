import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON-хранилище без зависимостей.
 *
 * Схема:
 * {
 *   settings: {...},
 *   sources: ['@source1', '@source2'],
 *   places: { chernihiv: ['остер', ...], sumy: ['ворожба', ...] },
 *   dedup: { [hash]: timestampMs },
 *   queue: { [id]: {...} },
 *   seq: { queueId: 1 }
 * }
 */

const DEFAULT_DATA = {
  settings: {
    mode: 'manual',
    targetChannel: '',
    allowedRegions: ['chernihiv', 'sumy'],
    dedupWindowMin: 60,
    alertsEnabled: true,
    alertsChannel: '',
    alertsIncludeTime: false,
    showSource: true,
  },
  sources: [],
  places: { chernihiv: [], sumy: [] },
  dedup: {},
  queue: {},
  seenHashes: {},   // { [hash]: timestamp }
  seq: { queueId: 1 },
};

function safeReadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function atomicWriteJSON(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export function initStore({ path: filePath }) {
  const data = safeReadJSON(filePath) || structuredClone(DEFAULT_DATA);

  // merge defaults
  data.settings = { ...DEFAULT_DATA.settings, ...(data.settings || {}) };
  data.sources = Array.isArray(data.sources) ? data.sources : [];
  data.places = data.places && typeof data.places === 'object' ? data.places : {};
  data.places.chernihiv = Array.isArray(data.places.chernihiv) ? data.places.chernihiv : [];
  data.places.sumy = Array.isArray(data.places.sumy) ? data.places.sumy : [];
  data.dedup = data.dedup && typeof data.dedup === 'object' ? data.dedup : {};
  data.queue = data.queue && typeof data.queue === 'object' ? data.queue : {};
  data.seq = { ...DEFAULT_DATA.seq, ...(data.seq || {}) };

  function save() {
    atomicWriteJSON(filePath, data);
  }

  function getSettings() {
    return data.settings;
  }

  function updateSettings(patch) {
    data.settings = { ...data.settings, ...patch };
    save();
    return data.settings;
  }

  function listSources() {
    return [...data.sources];
  }

  function addSource(src) {
    const norm = normalizeChannel(src);
    if (!norm) return false;
    if (!data.sources.includes(norm)) {
      data.sources.push(norm);
      save();
    }
    return true;
  }

  function removeSource(src) {
    const norm = normalizeChannel(src);
    const before = data.sources.length;
    data.sources = data.sources.filter(s => s !== norm);
    const changed = data.sources.length !== before;
    if (changed) save();
    return changed;
  }

  function clearSources() {
    data.sources = [];
    save();
  }

  // --- Places ---
  function getPlaces() {
    return {
      chernihiv: [...data.places.chernihiv],
      sumy: [...data.places.sumy],
    };
  }

  function listPlaces(region) {
    const r = normalizeRegion(region);
    if (!r) return [];
    return [...data.places[r]];
  }

  function addPlace(region, place) {
    const r = normalizeRegion(region);
    const p = normalizePlace(place);
    if (!r || !p) return false;
    if (!data.places[r].includes(p)) {
      data.places[r].push(p);
      save();
    }
    return true;
  }

  function removePlace(region, place) {
    const r = normalizeRegion(region);
    const p = normalizePlace(place);
    if (!r || !p) return false;
    const before = data.places[r].length;
    data.places[r] = data.places[r].filter(x => x !== p);
    const changed = data.places[r].length !== before;
    if (changed) save();
    return changed;
  }

  function clearPlaces(region) {
    const r = normalizeRegion(region);
    if (!r) return false;
    data.places[r] = [];
    save();
    return true;
  }

  // --- Dedup ---
  function dedupSeen(hash, windowMin) {
    const now = Date.now();
    const ts = Number(data.dedup[hash] || 0);
    if (ts && (now - ts) < windowMin * 60_000) return true;
    return false;
  }

  function dedupMark(hash) {
    data.dedup[hash] = Date.now();
    save();
  }

  function dedupCleanup(windowMin) {
    const cutoff = Date.now() - windowMin * 60_000;
    let changed = false;
    for (const [h, ts] of Object.entries(data.dedup)) {
      if (Number(ts) < cutoff) {
        delete data.dedup[h];
        changed = true;
      }
    }
    if (changed) save();
  }

  // --- Queue ---
  function queueAdd({ source, rawText, formattedText }) {
    const id = data.seq.queueId++;
    data.queue[String(id)] = {
      id,
      source,
      rawText,
      formattedText,
        createdAt: Date.now(),
        status: 'pending',
    };
    save();
    return id;
  }

  function queueGet(id) {
    return data.queue[String(id)] || null;
  }

  function queueSetStatus(id, status) {
    const item = data.queue[String(id)];
    if (!item) return false;
    item.status = status;
    save();
    return true;
  }

  function queueListPending(limit = 10) {
    const items = Object.values(data.queue)
    .filter(x => x && x.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
    return items;
  }

  function queueCountPending() {
    return Object.values(data.queue).filter(x => x?.status === 'pending').length;
  }

  // ensure file exists
  save();

  return {
    getSettings,
    updateSettings,
    listSources,
    addSource,
    removeSource,
    clearSources,

    // places API
    getPlaces,
    listPlaces,
    addPlace,
    removePlace,
    clearPlaces,

    dedupSeen,
    dedupMark,
    dedupCleanup,
    queueAdd,
    queueGet,
    queueSetStatus,
    queueListPending,
    queueCountPending,
  };
}

export function hasSeen(hash, ttlMs = 6 * 60 * 60 * 1000) { // 6 часов
  const ts = state.seenHashes[hash];
  if (!ts) return false;
  if (Date.now() - ts > ttlMs) {
    delete state.seenHashes[hash];
    save();
    return false;
  }
  return true;
}

export function markSeen(hash) {
  state.seenHashes[hash] = Date.now();
  save();
}

export function normalizeChannel(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  if (t.startsWith('@')) return t;
  if (t.startsWith('https://t.me/')) return '@' + t.replace('https://t.me/', '').replace('/', '');
    if (t.startsWith('t.me/')) return '@' + t.replace('t.me/', '').replace('/', '');
    if (/^[a-zA-Z0-9_]{4,}$/.test(t)) return '@' + t;
    return '';
}

export function normalizeRegion(s) {
  const t = String(s || '').trim().toLowerCase();
  if (t === 'chernihiv' || t === 'чернигов' || t === 'чернігів' || t === 'cn') return 'chernihiv';
  if (t === 'sumy' || t === 'сумы' || t === 'суми' || t === 'sm') return 'sumy';
  return (t === 'chernihiv' || t === 'sumy') ? t : '';
}

export function normalizePlace(s) {
  if (!s) return '';
  return String(s)
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[’'`]/g, '')
  .replace(/[^a-zа-яіїє0-9\s-]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
}
