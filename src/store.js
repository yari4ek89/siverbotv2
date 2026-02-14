import fs from 'node:fs';
import path from 'node:path';

/**
 * Простое JSON-хранилище (без нативных зависимостей), чтобы деплой не страдал.
 *
 * Схема:
 * {
 *   settings: {
 *     mode: 'manual'|'auto',
 *     targetChannel: '@channel',
 *     allowedRegions: ['chernihiv','sumy'],
 *     dedupWindowMin: 60,
 *     alertsEnabled: true,
 *     alertsChannel: '@channel' | null,
 *     alertsIncludeTime: false
 *   },
 *   sources: ['@source1', '@source2'],
 *   dedup: { [hash]: timestampMs },
 *   queue: { [id]: {id, source, rawText, formattedText, createdAt, status} },
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
  },
  sources: [],
  dedup: {},
  queue: {},
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

  // merge defaults (на случай обновлений)
  data.settings = { ...DEFAULT_DATA.settings, ...(data.settings || {}) };
  data.sources = Array.isArray(data.sources) ? data.sources : [];
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

  // initial save to ensure file exists
  save();

  return {
    getSettings,
    updateSettings,
    listSources,
    addSource,
    removeSource,
    clearSources,
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

export function normalizeChannel(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  if (t.startsWith('@')) return t;
  if (t.startsWith('https://t.me/')) return '@' + t.replace('https://t.me/', '').replace('/', '');
  if (t.startsWith('t.me/')) return '@' + t.replace('t.me/', '').replace('/', '');
  // allow bare username
  if (/^[a-zA-Z0-9_]{4,}$/.test(t)) return '@' + t;
  return '';
}
