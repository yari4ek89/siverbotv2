import crypto from 'node:crypto';

export function normalizeText(raw) {
  if (!raw) return '';
  let t = String(raw);

  // 1) remove explicit source links/mentions
  t = t.replace(/https?:\/\/t\.me\/[\w\d_\/]+/gi, '');
  t = t.replace(/\B@[a-zA-Z0-9_]{4,}/g, '');

  // 2) remove timestamps (we don't want "01:37" etc.)
  t = t.replace(/\b\d{1,2}:\d{2}\b/g, '');

  // 3) remove typical noise markers
  t = t.replace(/\b(UPD|UPDATE|ОНОВЛЕНО|ОБНОВЛЕНО|АПД)\b\s*[:\-–—]?/gi, '');
  t = t.replace(/[‼!]{2,}/g, '!');

  // 4) compress spaces
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function detectThreatEmoji(text) {
  const t = (text || '').toLowerCase();
  if (/(шахед|shahed|бплa|бпла|бпла|дрон|drone|бпл)/i.test(t)) return '🛸';
  if (/(ракета|крылат|крилат|баллист|баліст)/i.test(t)) return '🚀';
  if (/(авіац|авиац|каб|kаb|бомб)/i.test(t)) return '✈️';
  if (/(обстріл|обстрел|артил|артилер)/i.test(t)) return '💥';
  if (/(ппо|збито|сбили|перехоп)/i.test(t)) return '🛡️';
  return 'ℹ️';
}

// --- Regions ---

const REGION_KEYWORDS = {
  chernihiv: [
    'черніг', 'черниг', 'чернігівщина', 'черниговщина', 'ніжин', 'ніж', 'нежин',
    'прилук', 'бахмач', 'новгород-сівер', 'новгород север', 'сновськ', 'корюків',
    'чернігівськ', 'черниговск'
  ],
  sumy: [
    'сум', 'сумщина', 'конотоп', 'шостк', 'охтир', 'глух', 'кролевец', 'кролевець',
    'ромн', 'лебедин', 'білопіл', 'белополь'
  ],
};

export function detectRegions(text) {
  const t = (text || '').toLowerCase();
  const found = new Set();
  for (const [region, keys] of Object.entries(REGION_KEYWORDS)) {
    if (keys.some(k => t.includes(k))) found.add(region);
  }
  return [...found];
}

// Extract "from" and "to" parts very roughly.
export function extractWhereTo(text) {
  const t = text || '';
  const lower = t.toLowerCase();

  // "курс на X" / "напрямок на X" / "в бік X" / "рух до X"
  const toMatch = lower.match(/(курс\s+на|напрям(ок)?\s+на|в\s+бік|рух(ається)?\s+до|летить\s+на)\s+([^,.!;]+)/i);
  const to = toMatch ? cleanupPlace(toMatch[3]) : '';

  // "з X" / "зі сторони X" / "з району X"
  const fromMatch = lower.match(/(з|зі)\s+(сторони\s+)?(району\s+)?([^,.!;]+)/i);
  const from = fromMatch ? cleanupPlace(fromMatch[4]) : '';

  return { from, to };
}

function cleanupPlace(s) {
  if (!s) return '';
  return String(s)
    .replace(/\b(обл\.?|область|район(у)?|р-н|г\.|місто|м\.)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPost(rawText) {
  const normalized = normalizeText(rawText);
  const emoji = detectThreatEmoji(normalized);
  const label = detectThreatLabel(normalized);
  const { from, to } = extractWhereTo(normalized);

  let core = '';

  if (to) {
    core = from ? `з ${from} → курс на ${to}` : `курс на ${to}`;
  } else {
    // если не нашли "куда", делаем короткую "сводку" без копипаста
    core = shortSummary(normalized);
  }

  core = core.replace(/[.\s]+$/g, '').trim();
  if (core.length > 220) core = core.slice(0, 217) + '…';

  return `${emoji} ${label}: ${capitalizeFirst(core)}.`;
}

function detectThreatLabel(text) {
  const t = (text || '').toLowerCase();
  if (/(шахед|shah(ed)?|бпла|бплa|дрон|drone|бпл)/i.test(t)) return 'БПЛА';
  if (/(ракета|крылат|крилат|баллист|баліст)/i.test(t)) return 'Ракетна загроза';
  if (/(авіац|авиац|каб|бомб)/i.test(t)) return 'Авіаційна загроза';
  if (/(обстріл|обстрел|артил)/i.test(t)) return 'Обстріл';
  if (/(ппо|збито|сбили|перехоп)/i.test(t)) return 'ППО';
  return 'Оновлення';
}

function shortSummary(text) {
  // вырезаем типовые слова, чтобы не было ощущения копипаста
  let t = String(text || '');
  t = t.replace(/\b(дрон(и)?|бпла|шахед(и)?|ракета(и)?|курс|напрямок|напрям|летить|рух(ається)?)\b/gi, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return 'Рух виявлено';
  return t;
}


function capitalizeFirst(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}
