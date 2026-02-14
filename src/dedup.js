// src/dedup.js
import crypto from 'node:crypto';

export function makeDedupKey({ label, region, from, to }) {
  const safe = (s) => (s || '')
    .toLowerCase()
    .replace(/[^a-zа-яіїє0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Канонический ключ — максимально устойчив к перефразу
  const key = [
    safe(label) || 'unknown',
    safe(region) || 'unknown',
    `to:${safe(to) || '-'}`,
    `from:${safe(from) || '-'}`,
  ].join('|');

  // Хэш чтобы ключ был компактным
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function tokenizeForSimilarity(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')     // таймкоды
    .replace(/\b\d+\b/g, ' ')                  // числа
    .replace(/[^a-zа-яіїє\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stop = new Set([
    'курс','напрямок','напрям','летить','рухається','рух','повідомляють','увага',
    'upd','апд','оновлення','інфо','info','район','область','обл','місто'
  ]);

  return new Set(
    t.split(' ')
     .filter(w => w.length >= 3 && !stop.has(w))
  );
}

export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

