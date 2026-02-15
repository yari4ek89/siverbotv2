import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Markup } from 'telegraf';
import { NewMessage } from 'telegram/events/NewMessage.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { makeDedupKey, tokenizeForSimilarity, jaccard } from './dedup.js';

import {
  buildPost,
  detectRegions,
  hashText,
  normalizeText,
  extractWhereTo,
  detectThreatEmoji,
} from './formatter.js';


let sourceIdSet = new Set();
let sourceUserSet = new Set();
let sourceNameMap = new Map();
let sourceEntities = new Map();
let lastSourcesSig = '';
let lastSourceRefreshTs = 0;

async function refreshSourceIds(force = false) {
  const now = Date.now();
  if (!force && now - lastRefreshTs < 30_000 && sourceIdSet.size) return;
  lastRefreshTs = now;

  // ✅ достаём sources безопасно (может быть sync или async)
  let sources = [];
  try {
    if (typeof store.listSources === 'function') {
      sources = store.listSources();
    } else if (typeof store.getSources === 'function') {
      sources = await Promise.resolve(store.getSources());
    }
  } catch {
    sources = [];
  }
  if (!Array.isArray(sources)) sources = [];

  const sig = sources.map(normalizeUsername).sort().join(',');
  if (!force && sig === lastSourcesSig && sourceIdSet.size) return;
  lastSourcesSig = sig;

  const newIdSet = new Set();
  const newUserSet = new Set();
  const newMap = new Map();

  for (const s of sources) {
    try {
      const name = String(s).replace('https://t.me/', '').replace('t.me/', '').trim();
      const u = (name.startsWith('@') ? name : '@' + name).toLowerCase();

      const ent = await client.getEntity(u);
      const id = entityIdStr(ent);

      newIdSet.add(id);
      newUserSet.add(u);
      newMap.set(id, u);

      console.log('[osint] source ok:', u, '-> id', id);
    } catch (e) {
      console.log('[osint] source FAIL:', s, e?.message || e);
    }
  }

  sourceIdSet = newIdSet;
  sourceUserSet = newUserSet;
  sourceNameMap = newMap;

  console.log('[osint] sources resolved:', sourceIdSet.size);
  try {
    const settings = store.getSettings();
    const target = settings.targetChannel;
    if (target) {
      const text =
      `🤖 Бот запущено\n` +
      `Режим: ${settings.mode || 'manual'}\n` +
      `Регіони: ${(settings.allowedRegions || []).join(', ') || '-'}\n` +
      `Джерела: ${(store.listSources?.() || []).length}`;
      await bot.telegram.sendMessage(target, text, { disable_web_page_preview: true });
    }
  } catch (e) {
    console.log('[osint] start notify failed:', e?.message || e);
  }
}


function peerChannelIdStr(peerId) {
  // peerId обычно Api.PeerChannel
  const cid = peerId?.channelId;
  if (!cid) return null;
  // у gramjs иногда bigInt-объект
  return String(cid?.value ?? cid);
}

function entityIdStr(entity) {
  const id = entity?.id;
  return String(id?.value ?? id);
}

function kbForQueue(id) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `OSINT_APPROVE_${id}`),
      Markup.button.callback('❌ Reject', `OSINT_REJECT_${id}`),
    ],
    [Markup.button.callback('👁 Original', `OSINT_ORIG_${id}`)],
  ]);
}

function normalizeUsername(u) {
  if (!u) return '';
  let t = String(u).trim();
  if (t.startsWith('@')) t = t.slice(1);
  return t.toLowerCase();
}

export function startOsintReader({ bot, store, adminId, apiId, apiHash, sessionString }) {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });

	// Anti-duplicate for paraphrases (in-memory)
	const recentSim = []; // { ts: number, tokens: Set<string> }

function tokenizeForSimilarity(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^a-zа-яіїє\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stop = new Set([
    'курс','напрямок','напрям','летить','рухається','рух','увага','оновлення','upd','апд',
    'район','область','обл','місто','м'
  ]);

  return new Set(
    t.split(' ').filter(w => w.length >= 3 && !stop.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}


  // --- Approve / Reject callbacks ---
  bot.action(/OSINT_APPROVE_(\d+)/, async (ctx) => {
    if (Number(ctx.from?.id) !== Number(adminId)) return;
    const id = Number(ctx.match[1]);
    const item = store.queueGet(id);
    if (!item || item.status !== 'pending') {
      await ctx.answerCbQuery('Немає в черзі');
      return;
    }
    const settings = store.getSettings();
    if (!settings.targetChannel) {
      await ctx.answerCbQuery('Target не задан');
      await ctx.reply('Спочатку задай target: /panel → Target');
      return;
    }
    await ctx.telegram.sendMessage(settings.targetChannel, item.formattedText, { disable_web_page_preview: true });
    store.queueSetStatus(id, 'approved');
    store.dedupMark(item.dedupHash || hashText(normalizeText(item.formattedText)));
    await ctx.answerCbQuery('Опубліковано');
    try {
      await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback('✅ Approved', 'OSINT_NOP')]]).reply_markup);
    } catch {}
  });

  bot.action(/OSINT_REJECT_(\d+)/, async (ctx) => {
    if (Number(ctx.from?.id) !== Number(adminId)) return;
    const id = Number(ctx.match[1]);
    const item = store.queueGet(id);
    if (!item || item.status !== 'pending') {
      await ctx.answerCbQuery('Немає в черзі');
      return;
    }
    store.queueSetStatus(id, 'rejected');
    await ctx.answerCbQuery('Відхилено');
    try {
      await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback('❌ Rejected', 'OSINT_NOP')]]).reply_markup);
    } catch {}
  });

  bot.action(/OSINT_ORIG_(\d+)/, async (ctx) => {
    if (Number(ctx.from?.id) !== Number(adminId)) return;
    const id = Number(ctx.match[1]);
    const item = store.queueGet(id);
    if (!item) {
      await ctx.answerCbQuery('Немає');
      return;
    }
    await ctx.answerCbQuery();
    const raw = (item.rawText || '').slice(0, 3800);
    await ctx.reply(`📄 Original (#${id}):\n\n${raw || '(empty)'}`);
  });

  bot.action('OSINT_NOP', async (ctx) => {
    await ctx.answerCbQuery();
  });


  async function refreshSources(force = false) {
    const now = Date.now();
    if (!force && (now - lastSourceRefreshTs) < 30_000 && sourceIdSet.size) return;
    lastSourceRefreshTs = now;

    const sourcesRaw = (typeof store.listSources === 'function')
      ? store.listSources()
      : (typeof store.getSources === 'function' ? await Promise.resolve(store.getSources()) : []);

    const sources = Array.isArray(sourcesRaw) ? sourcesRaw : [];
    const sig = sources.map(s => normalizeUsername(s)).sort().join(',');
    if (!force && sig === lastSourcesSig && sourceIdSet.size) return;
    lastSourcesSig = sig;

    const newIdSet = new Set();
    const newUserSet = new Set();
    const newNameMap = new Map();
    const newEntities = new Map();

    for (const s of sources) {
      try {
        let name = String(s).trim();
        name = name.replace('https://t.me/', '').replace('t.me/', '').replace(/^@/, '');
        if (!name) continue;
        const unameNorm = name.toLowerCase();
        const ent = await client.getEntity('@' + unameNorm);
        const idStr = entityIdStr(ent);
        newIdSet.add(idStr);
        newUserSet.add(unameNorm);
        newNameMap.set(idStr, '@' + unameNorm);
        newEntities.set(idStr, ent);
        console.log('[osint] source ok:', '@' + unameNorm, '-> id', idStr);
      } catch (e) {
        console.log('[osint] source FAIL:', s, e?.message || e);
      }
    }

    sourceIdSet = newIdSet;
    sourceUserSet = newUserSet;
    sourceNameMap = newNameMap;
    sourceEntities = newEntities;

    console.log('[osint] sources resolved:', sourceIdSet.size);
  }

async function connect() {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      console.error('[osint] session is not authorized. Generate a valid SESSION_STRING.');
    }
        await refreshSources(true);
console.log('[osint] connected');
  }

  connect().catch(e => {
    console.error('[osint] connect error:', e?.message || e);
  });

  // Polling fallback: fetch latest messages from sources periodically (works even if Telegram updates don't arrive)
  const lastSeenBySource = new Map(); // idStr -> last message id

  async function pollSourcesOnce() {
    try {
      await refreshSources(false);
      if (!sourceEntities || !sourceEntities.size) return;

      for (const [idStr, ent] of sourceEntities.entries()) {
        let msgs = [];
        try {
          msgs = await client.getMessages(ent, { limit: 5 });
        } catch {
          continue;
        }
        if (!Array.isArray(msgs) || !msgs.length) continue;

        // process from oldest to newest
        msgs = msgs.slice().reverse();
        const lastSeen = Number(lastSeenBySource.get(idStr) || 0);

        for (const m of msgs) {
          const mid = Number(m?.id || 0);
          if (!mid || mid <= lastSeen) continue;
          // fabricate event-like object
          await handleIncoming({ message: m });
        }
        const newest = Number(msgs[msgs.length - 1]?.id || 0);
        if (newest) lastSeenBySource.set(idStr, newest);
      }
    } catch (e) {
      console.log('[osint] poll error:', e?.message || e);
    }
  }

  const pollMs = 30_000;
  const pollTimer = setInterval(pollSourcesOnce, pollMs);
  pollTimer.unref?.();

  async function handleIncoming(event) {
    try {
      const settings = store.getSettings();
      const mode = settings.mode;
      const target = settings.targetChannel;

      // We still want to process in manual even if target not set (user can set later)


      await refreshSources(false);
      if (!sourceIdSet.size && !sourceUserSet.size) return;

      const msg = event.message;
      if (!msg) return;

      const chId = peerChannelIdStr(msg.peerId);
      if (!chId) return;

      let chat;
      try { chat = await msg.getChat(); } catch { chat = null; }
      const uname = normalizeUsername(chat?.username);
      const isSource = sourceIdSet.has(chId) || (uname && sourceUserSet.has(uname));
      if (!isSource) return;

      const rawText = msg.message || '';
      if (!rawText.trim()) return;
// Slice multi-region digests: keep only lines/bullets that match allowed regions
      const allowed = new Set((settings.allowedRegions || []).map(r => String(r)));
      const extraPlaces = store.getPlaces ? store.getPlaces() : null;

      const parts = String(rawText)
        .split(/\n|•|·|\u2022|\u25AA|\u25CF/g)
        .map(s => s.trim())
        .filter(Boolean);

      const kept = parts.filter(line => {
        const regs = detectRegions(line, extraPlaces);
        return regs.some(r => allowed.has(r));
      });

      if (!kept.length) return;
      const filteredText = kept.join('\n');
       const sourceName = (uname ? '@' + uname : (sourceNameMap.get(chId) || ('id:' + chId)));

      const formatted = buildPost(filteredText, {
        sourceName,
        showSource: !!settings.showSource,
      });

      let regionsFound = detectRegions(filteredText, extraPlaces);
      if (!regionsFound.length) regionsFound = detectRegions(formatted, extraPlaces);
      if (!regionsFound.length) return;
      if (!regionsFound.some(r => allowed.has(r))) return;

// Dedup (stable key + paraphrase similarity)
const dedupWindowMin = Number(settings.dedupWindowMin || 60);
store.dedupCleanup(dedupWindowMin);

// делаем ключ не по тексту, а по “смыслу”: тип(эмодзи) + регион + куда/откуда
const normRaw = normalizeText(filteredText);
const emoji = detectThreatEmoji(normRaw);
const { from, to } = extractWhereTo(normRaw);
const regionKey = regionsFound.slice().sort().join(',');

const h = hashText(`${emoji}|${regionKey}|to:${(to||'-').toLowerCase()}|from:${(from||'-').toLowerCase()}`);
if (store.dedupSeen(h, dedupWindowMin)) return;

// третий пункт: если “куда/откуда” не вытащили — ловим перефразы по похожести слов
if (!to && !from) {
  const now = Date.now();
  const cutoff = now - dedupWindowMin * 60_000;

  // чистим старое
  for (let i = recentSim.length - 1; i >= 0; i--) {
    if (recentSim[i].ts < cutoff) recentSim.splice(i, 1);
  }

  const curTok = tokenizeForSimilarity(normRaw);
  for (const r of recentSim) {
    if (jaccard(curTok, r.tokens) >= 0.85) return; // дубль-перефраз
  }
  recentSim.push({ ts: now, tokens: curTok });
}

      if (mode === 'auto') {
        if (!target) return;
        await bot.telegram.sendMessage(target, formatted, { disable_web_page_preview: true });
        store.dedupMark(h);
        return;
      }

      // manual
      function isAllClearOrStatus(text) {
        const t = String(text || '').toLowerCase();

        const statusWords = [
          'відбій', 'отбой', 'відміна', 'скасовано',
          'спокійно', 'чисто', 'без загроз', 'загроз немає', 'не фіксується',
          'оновлення:', 'оновлення', 'обновление'
        ];

        const threatWords = [
          'бпла', 'бпл', 'дрон', 'шахед', 'shahed',
          'ракета', 'калібр', 'іскандер', 'крилат', 'балліст',
          'авіа', 'каб', 'кab', 'керован', 'пуск', 'зліт',
          'курс', 'на ', 'повз', 'у напрямку', 'пролітає'
        ];

        // если есть явные слова угрозы — это НЕ отбой
        if (threatWords.some(w => t.includes(w))) return false;

        // если есть слова статуса — это отбой/инфо
        if (statusWords.some(w => t.includes(w))) return true;

        // зелёные кружки часто у статусов
        if (t.includes('🟢') || t.includes('✅') || t.includes('🔵')) return true;

        return false;
      }

      const id = store.queueAdd({ source: sourceName, rawText: filteredText, formattedText: formatted, dedupHash: h });
      await bot.telegram.sendMessage(adminId, `📝 Pending #${id}\nFrom: ${sourceName}\n\n${formatted}`, kbForQueue(id));
      // do not mark dedup until approved (so you can reject and later accept a similar message)
    } catch (e) {
      console.error('[osint] handler error:', e?.message || e);
    }
    }

  client.addEventHandler(handleIncoming, new NewMessage({}));
  client.addEventHandler(handleIncoming, new EditedMessage({}));

  console.log('[osint] reader started');
}
