import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Markup } from 'telegraf';
import { NewMessage } from 'telegram/events/NewMessage.js';

import {
  buildPost,
  detectRegions,
  hashText,
  normalizeText,
  extractWhereTo,
  detectThreatEmoji,
} from './formatter.js';

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
function isStatusNoThreat(text) {
  const t = String(text || '').toLowerCase();

  const threatWords = [
    'бпла', 'бпл', 'дрон', 'шахед', 'shahed',
    'ракета', 'калібр', 'іскандер', 'крилат', 'балліст',
    'авіа', 'каб', 'кab', 'керован', 'пуск', 'зліт',
    'курс', 'на ', 'повз', 'у напрямку', 'пролітає',
  ];
  if (threatWords.some(w => t.includes(w))) return false;

  

  // Не публікуємо повідомлення про (повітряну) тривогу / відбій тривоги як окремі пости
  // (але якщо в тексті є явні маркери загрози — вище ми вже повернули false, і таке не відсікаємо)
  const alarmPhrases = [
    'повітряна тривога', 'повітряної тривоги', 'повітряну тривогу',
    'відбій тривоги', 'відбій повітряної тривоги',
    'воздушная тревога', 'отбой тревоги',
    'air raid alert', 'air raid alarm',
  ];
  if (alarmPhrases.some(p => t.includes(p))) return true;
  // на випадок коротких повідомлень типу "Тривога!"
  if (t.includes('тривога') || t.includes('тривоги') || t.includes('тривогу')) return true;

const statusWords = [
    'відбій', 'отбой', 'відміна', 'скасовано',
    'спокійно', 'чисто', 'без загроз', 'загроз немає', 'не фіксується',
    'оновлення', 'обновление',
  ];
  if (statusWords.some(w => t.includes(w))) return true;

  if (t.includes('🟢') || t.includes('✅') || t.includes('🔵')) return true;

  return false;
}


export function startOsintReader({ bot, store, adminId, apiId, apiHash, sessionString }) {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });
	


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

	const sources = await store.getSources(); // как у тебя получаются sources из админки
const sourceIdSet = new Set();

for (const s of sources) {
  try {
    const name = String(s).replace('https://t.me/', '').replace('t.me/', '').trim();
    const username = name.startsWith('@') ? name : '@' + name;

    const ent = await client.getEntity(username);
    sourceIdSet.add(entityIdStr(ent));

    console.log('[osint] source ok:', username, '-> id', entityIdStr(ent));
  } catch (e) {
    console.log('[osint] source FAIL:', s, e?.message || e);
  }
}

console.log('[osint] sources resolved:', sourceIdSet.size);
  

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

      // Skip “all-clear / status” updates (no threat)
      if (isStatusNoThreat(rawText)) return;

      // Anti-spam disabled: keep a hash for reference only
      const h = hashText(normalizeText(formatted));

      if (mode === 'auto') {
        if (!target) return;
        await bot.telegram.sendMessage(target, formatted, { disable_web_page_preview: true });
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
