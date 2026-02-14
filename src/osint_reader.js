import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Markup } from 'telegraf';
import { NewMessage } from 'telegram/events/NewMessage.js';
import { makeDedupKey, tokenizeForSimilarity, jaccard } from './dedup.js';

import {
  buildPost,
  detectRegions,
  hashText,
  normalizeText,
  extractWhereTo,
  detectThreatEmoji,
} from './formatter.js';


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

  async function connect() {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      console.error('[osint] session is not authorized. Generate a valid SESSION_STRING.');
    }
    console.log('[osint] connected');
  }

  connect().catch(e => {
    console.error('[osint] connect error:', e?.message || e);
  });

  // --- Main event handler ---
  client.addEventHandler(async (event) => {
    try {
      const settings = store.getSettings();
      const mode = settings.mode;
      const target = settings.targetChannel;

      // We still want to process in manual even if target not set (user can set later)

      const sources = store.listSources();
      if (!sources.length) return;

      const srcSet = new Set(sources.map(s => normalizeUsername(s)));

      const msg = event.message;
      if (!msg) return;
      const chat = await msg.getChat();
      const username = normalizeUsername(chat?.username);
      if (!username || !srcSet.has(username)) return;

      const rawText = msg.message || '';
      if (!rawText.trim()) return;

      const formatted = buildPost(rawText);

      // Regions filter (strict): must detect at least one allowed region
      const regionsFound = detectRegions(formatted);
      if (!regionsFound.length) return;
      const allowed = new Set(settings.allowedRegions || []);
      if (!regionsFound.some(r => allowed.has(r))) return;

// Dedup (stable key + paraphrase similarity)
const dedupWindowMin = Number(settings.dedupWindowMin || 60);
store.dedupCleanup(dedupWindowMin);

// делаем ключ не по тексту, а по “смыслу”: тип(эмодзи) + регион + куда/откуда
const normRaw = normalizeText(rawText);
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
      const id = store.queueAdd({ source: '@' + username, rawText, formattedText: formatted, dedupHash: h });
      await bot.telegram.sendMessage(adminId, `📝 Pending #${id}\nFrom: @${username}\n\n${formatted}`, kbForQueue(id));
      // do not mark dedup until approved (so you can reject and later accept a similar message)
    } catch (e) {
      console.error('[osint] handler error:', e?.message || e);
    }
  }, new NewMessage({}));

  console.log('[osint] reader started');
}
