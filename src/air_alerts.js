import fs from 'node:fs';

// ⚠️ ЭТА ЧАСТЬ — твой бот по повітряній тривозі. НЕ УДАЛЯЕМ.
// Мы просто вынесли в модуль и сделали канал/формат управляемыми через панель.

const ALERTS_URL = process.env.ALERTS_URL;
const ALERTS_TOKEN = process.env.ALERTS_TOKEN;
const ALERTS_AUTH_HEADER = process.env.ALERTS_AUTH_HEADER || 'Authorization';
const ALERTS_AUTH_PREFIX = process.env.ALERTS_AUTH_PREFIX || 'Bearer';

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);
const CONFIRM_COUNT = Number(process.env.CONFIRM_COUNT || 2);
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || 60);
const UID_OFFSET = Number(process.env.UID_OFFSET || 0);
const ACTIVE_SYMBOLS = new Set((process.env.ACTIVE_SYMBOLS || 'A').split(',').map(s => s.trim()).filter(Boolean));

const STATE_FILE = 'state.json';
const DISTRICTS_FILE = 'districts.json';

function loadDistricts() {
  if (!fs.existsSync(DISTRICTS_FILE)) {
    console.error(`Missing ${DISTRICTS_FILE}.`);
    return [];
  }
  const raw = fs.readFileSync(DISTRICTS_FILE, 'utf-8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(x => ({
    uid: Number(x.uid),
    name: String(x.name || '').trim()
  })).filter(x => Number.isFinite(x.uid) && x.uid >= 0 && x.name.length > 0);
}

const DISTRICTS = loadDistricts();

function nowHHMM() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { prev: {}, pending: {}, lastSentAt: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const s = JSON.parse(raw);
    return {
      prev: s.prev || {},
      pending: s.pending || {},
      lastSentAt: s.lastSentAt || {}
    };
  } catch {
    return { prev: {}, pending: {}, lastSentAt: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getCharByUid(bigString, uid) {
  const idx = uid + UID_OFFSET;
  if (idx < 0 || idx >= bigString.length) return null;
  return bigString[idx];
}

function isActiveChar(ch) {
  if (!ch) return false;
  return ACTIVE_SYMBOLS.has(ch);
}

async function fetchBigString() {
  if (!ALERTS_URL || !ALERTS_TOKEN) {
    throw new Error('Missing ALERTS_URL/ALERTS_TOKEN in env');
  }

  const headers = { 'Accept': '*/*' };
  if (ALERTS_AUTH_HEADER.toLowerCase() === 'authorization') {
    headers[ALERTS_AUTH_HEADER] = `${ALERTS_AUTH_PREFIX} ${ALERTS_TOKEN}`.trim();
  } else {
    headers[ALERTS_AUTH_HEADER] = ALERTS_TOKEN;
  }

  const res = await fetch(ALERTS_URL, { headers });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`alerts api ${res.status}: ${t.slice(0, 200)}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json();
    if (typeof j === 'string') return j;
    for (const key of ['data', 'alerts', 'value', 'result']) {
      if (typeof j?.[key] === 'string') return j[key];
    }
    throw new Error('Unexpected JSON format from alerts api (expected big string).');
  }

  return await res.text();
}

function cooldownPassed(state, key) {
  const last = Number(state.lastSentAt[key] || 0);
  const now = Date.now();
  return (now - last) >= COOLDOWN_SECONDS * 1000;
}

function markSent(state, keys) {
  const now = Date.now();
  for (const k of keys) state.lastSentAt[k] = now;
}

function keyFor(uid) {
  return String(uid);
}

export function startAirAlertsPoller({ bot, store }) {
  const state = loadState();

  if (!DISTRICTS.length) {
    console.log('[alerts] districts.json empty -> alerts poller disabled');
    return;
  }

  async function tick() {
    try {
      const settings = store.getSettings();
      if (!settings.alertsEnabled) return;

      const channel = settings.alertsChannel || settings.targetChannel;
      if (!channel) return;

      const big = await fetchBigString();

      const turnedOn = [];
      const turnedOff = [];

      for (const d of DISTRICTS) {
        const k = keyFor(d.uid);
        const ch = getCharByUid(big, d.uid);
        const current = isActiveChar(ch);

        const prev = state.prev[k];
        const pending = state.pending[k];

        if (typeof prev !== 'boolean') {
          state.prev[k] = current;
          state.pending[k] = undefined;
          continue;
        }

        if (current === prev) {
          state.pending[k] = undefined;
          continue;
        }

        if (!pending || typeof pending.value !== 'boolean' || pending.value !== current) {
          state.pending[k] = { value: current, count: 1 };
          continue;
        }

        pending.count += 1;
        state.pending[k] = pending;

        if (pending.count < CONFIRM_COUNT) continue;

        state.prev[k] = current;
        state.pending[k] = undefined;

        if (!cooldownPassed(state, k)) continue;

        if (current) turnedOn.push(d.name);
        else turnedOff.push(d.name);

        markSent(state, [k]);
      }

      const time = nowHHMM();
      if (turnedOn.length) {
        const msg = settings.alertsIncludeTime
          ? `🛑 Повітряна тривога: ${turnedOn.join(', ')} | ${time}`
          : `🛑 Повітряна тривога: ${turnedOn.join(', ')}`;
        await bot.telegram.sendMessage(channel, msg, { disable_web_page_preview: true });
      }
      if (turnedOff.length) {
        const msg = settings.alertsIncludeTime
          ? `✅ Відбій повітряної тривоги: ${turnedOff.join(', ')} | ${time}`
          : `✅ Відбій повітряної тривоги: ${turnedOff.join(', ')}`;
        await bot.telegram.sendMessage(channel, msg, { disable_web_page_preview: true });
      }

      saveState(state);
    } catch (e) {
      console.error('[alerts] tick error:', e?.message || e);
    }
  }

  console.log(`[alerts] poller started: every ${POLL_SECONDS}s, districts=${DISTRICTS.length}`);
  tick();
  setInterval(tick, POLL_SECONDS * 1000);
}
