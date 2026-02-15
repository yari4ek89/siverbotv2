import { Markup } from 'telegraf';
import { normalizeChannel } from './store.js';

function isAdmin(ctx, adminId) {
  const uid = ctx?.from?.id;
  return Number(uid) === Number(adminId);
}

function panelKeyboard(store) {
  const s = store.getSettings();
  const mode = s.mode;
  const regions = new Set(s.allowedRegions || []);
  const rChern = regions.has('chernihiv');
  const rSumy = regions.has('sumy');

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Mode: ${mode === 'manual' ? 'MANUAL' : 'AUTO'}`, 'PANEL_MODE_TOGGLE'),
    ],
    [
      Markup.button.callback(`Target: ${s.targetChannel || 'не задан'}`, 'PANEL_SET_TARGET'),
    ],
    [
      Markup.button.callback(`Sources: ${store.listSources().length}`, 'PANEL_SOURCES'),
    ],
    [
      Markup.button.callback(`Region Чернігівська: ${rChern ? '✅' : '❌'}`, 'PANEL_REGION_CHERN'),
      Markup.button.callback(`Сумська: ${rSumy ? '✅' : '❌'}`, 'PANEL_REGION_SUMY'),
    ],
    [
      Markup.button.callback(`Pending: ${store.queueCountPending()}`, 'PANEL_QUEUE'),
      Markup.button.callback('Status', 'PANEL_STATUS'),
    ],
  ]);
}

async function showPanel(ctx, store) {
  const s = store.getSettings();
  const text =
    `🧩 Панель керування\n\n` +
    `• Mode: ${s.mode}\n` +
    `• Target: ${s.targetChannel || 'не задан'}\n` +
    `• Sources: ${store.listSources().length}\n` +
    `• Regions: ${(s.allowedRegions || []).join(', ') || 'none'}\n` +
    `• Pending approvals: ${store.queueCountPending()}\n`;

  await ctx.reply(text, panelKeyboard(store));
}

export function registerAdminPanel({ bot, store, adminId }) {
  // --- Basic access guard ---
  bot.use(async (ctx, next) => {
    // Let non-admins talk to bot (e.g. /start), but block admin commands/buttons.
    ctx.state.__isAdmin = isAdmin(ctx, adminId);
    return next();
  });

  bot.start(async (ctx) => {
    if (!ctx.state.__isAdmin) {
      await ctx.reply('Бот працює. (доступ до панелі — тільки адміну)');
      return;
    }
    await ctx.reply('Готовий. Відкрий панель: /panel');
  });

  bot.command('panel', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    await showPanel(ctx, store);
  });

  bot.command('mode', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const arg = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();
    if (arg !== 'manual' && arg !== 'auto') {
      await ctx.reply('Використання: /mode manual або /mode auto');
      return;
    }
    store.updateSettings({ mode: arg });
    try {
      const target = settingsAfter.targetChannel; // важно: берем уже обновлённые settings
      if (target) {
        const txt = (settingsAfter.mode === 'auto')
        ? '🟢 Режим: AUTO — публікація без підтвердження.'
        : '🟡 Режим: MANUAL — публікація тільки після підтвердження.';
        await bot.telegram.sendMessage(target, txt, { disable_web_page_preview: true });
      }
    } catch (e) {
      console.log('[panel] mode notify failed:', e?.message || e);
    }
    await ctx.reply(`Mode set to: ${arg}`);
  });

  bot.command('status', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const s = store.getSettings();
    await ctx.reply(
      `Status\n` +
      `• Mode: ${s.mode}\n` +
      `• Target: ${s.targetChannel || 'не задан'}\n` +
      `• Sources: ${store.listSources().length}\n` +
      `• Regions: ${(s.allowedRegions || []).join(', ') || 'none'}\n` +
      `• Pending: ${store.queueCountPending()}\n`
    );
  });

  bot.command('sources', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const list = store.listSources();
    await ctx.reply(list.length ? list.join('\n') : 'Sources порожні. Додай: /source_add @channel');
  });

  bot.command('source_add', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const arg = (ctx.message.text.split(' ').slice(1).join(' ') || '').trim();
    const norm = normalizeChannel(arg);
    if (!norm) {
      await ctx.reply('Невірний канал. Приклад: /source_add @channel');
      return;
    }
    store.addSource(norm);
    await ctx.reply(`Додано: ${norm}`);
  });

  bot.command('source_del', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const arg = (ctx.message.text.split(' ').slice(1).join(' ') || '').trim();
    const norm = normalizeChannel(arg);
    if (!norm) {
      await ctx.reply('Невірний канал. Приклад: /source_del @channel');
      return;
    }
    const ok = store.removeSource(norm);
    await ctx.reply(ok ? `Видалено: ${norm}` : `Не знайдено: ${norm}`);
  });

  // ---- Places ----
  bot.command('places', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const arg = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();

    if (!arg) {
      const ch = store.listPlaces('chernihiv');
      const su = store.listPlaces('sumy');
      await ctx.reply(
        `Places:\n` +
        `• chernihiv: ${ch.length}\n` +
        `• sumy: ${su.length}\n\n` +
        `Показати список: /places chernihiv або /places sumy`
      );
      return;
    }

    if (arg !== 'chernihiv' && arg !== 'sumy') {
      await ctx.reply('Регіон тільки: chernihiv або sumy');
      return;
    }

    const list = store.listPlaces(arg);
    if (!list.length) {
      await ctx.reply(`Список порожній для ${arg}. Додай: /place_add ${arg} Назва`);
      return;
    }

    // чтобы не упираться в лимиты, режем на куски
    const chunk = 150;
    for (let i = 0; i < list.length; i += chunk) {
      await ctx.reply(list.slice(i, i + chunk).join('\n'));
    }
  });

  bot.command('place_add', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const parts = ctx.message.text.split(' ').slice(1);
    const region = (parts.shift() || '').trim().toLowerCase();
    const place = parts.join(' ').trim();

    if (!region || !place) {
      await ctx.reply('Використання: /place_add chernihiv Остер');
      return;
    }
    if (region !== 'chernihiv' && region !== 'sumy') {
      await ctx.reply('Регіон тільки: chernihiv або sumy');
      return;
    }

    const ok = store.addPlace(region, place);
    await ctx.reply(ok ? `✅ Додано в ${region}: ${place}` : '❌ Не вдалося додати');
  });

  bot.command('place_del', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const parts = ctx.message.text.split(' ').slice(1);
    const region = (parts.shift() || '').trim().toLowerCase();
    const place = parts.join(' ').trim();

    if (!region || !place) {
      await ctx.reply('Використання: /place_del chernihiv Остер');
      return;
    }
    if (region !== 'chernihiv' && region !== 'sumy') {
      await ctx.reply('Регіон тільки: chernihiv або sumy');
      return;
    }

    const ok = store.removePlace(region, place);
    await ctx.reply(ok ? `🗑️ Видалено з ${region}: ${place}` : `Не знайдено: ${place}`);
  });


  bot.command('target', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    await ctx.reply('Введи target канал (наприклад @siverradar) одним повідомленням:');
    store.updateSettings({ __awaiting: { kind: 'target' } });
  });

  bot.command('queue', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const items = store.queueListPending(10);
    if (!items.length) {
      await ctx.reply('Черга порожня.');
      return;
    }
    const text = items.map(i => `#${i.id} • ${i.source}\n${(i.formattedText || '').slice(0, 120)}`).join('\n\n');
    await ctx.reply(text);
  });

  bot.command('approve', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const id = Number((ctx.message.text.split(' ')[1] || '').trim());
    if (!id) {
      await ctx.reply('Використання: /approve 123');
      return;
    }
    ctx.state.__manualApproveId = id;
    await ctx.reply(`Ок, approve #${id} через кнопку краще, але можу й командою. Пиши /do_approve ${id}`);
  });

  bot.command('pending', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const n = store.queueCountPending ? store.queueCountPending() : 0;
    await ctx.reply(`📌 Pending: ${n}`);
  });

  bot.command('approve_all', async (ctx) => {
    if (!ctx.state.__isAdmin) return;

    const arg = (ctx.message.text.split(' ')[1] || '').trim();
    const limit = arg ? Math.max(1, Math.min(200, Number(arg) || 0)) : 200;

    const items = store.queueListPending ? store.queueListPending(limit) : [];
    if (!items.length) {
      await ctx.reply('Pending пусто.');
      return;
    }

    const settings = store.getSettings();
    const target = settings.targetChannel;
    if (!target) {
      await ctx.reply('❌ targetChannel не задан. Задай в админке.');
      return;
    }

    let ok = 0, fail = 0;
    for (const it of items.reverse()) { // oldest -> newest
      try {
        await bot.telegram.sendMessage(target, it.formattedText, { disable_web_page_preview: true });
        store.queueSetStatus(it.id, 'approved');
        ok++;
      } catch (e) {
        fail++;
        // чтобы не стопорить всё из-за одной ошибки
        console.log('[panel] approve_all send fail:', it.id, e?.message || e);
      }
    }

    await ctx.reply(`✅ approve_all: отправлено ${ok}, ошибок ${fail}, лимит ${limit}`);
  });

  bot.command('reject_all', async (ctx) => {
    if (!ctx.state.__isAdmin) return;

    const arg = (ctx.message.text.split(' ')[1] || '').trim();
    const limit = arg ? Math.max(1, Math.min(500, Number(arg) || 0)) : 500;

    const items = store.queueListPending ? store.queueListPending(limit) : [];
    if (!items.length) {
      await ctx.reply('Pending пусто.');
      return;
    }

    for (const it of items) {
      store.queueSetStatus(it.id, 'rejected');
    }

    await ctx.reply(`🗑️ reject_all: отклонено ${items.length}, лимит ${limit}`);
  });

  bot.command('source_tag', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const arg = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();

    if (!['on','off'].includes(arg)) {
      await ctx.reply('Використання: /source_tag on або /source_tag off');
      return;
    }

    const settings = store.updateSettings({ showSource: arg === 'on' });
    await ctx.reply(`ℹ️ Джерело в постах: ${settings.showSource ? 'ON' : 'OFF'}`);
  });



  // quick command to avoid parsing issues
  bot.command('do_approve', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const id = Number((ctx.message.text.split(' ')[1] || '').trim());
    if (!id) return;
    await ctx.telegram.answerCbQuery?.('');
    await ctx.reply('Використай кнопки Approve/Reject у картці.');
  });

  // Handle plain messages for settarget
  bot.on('text', async (ctx, next) => {
    if (!ctx.state.__isAdmin) return next();
    const s = store.getSettings();
    const awaiting = s.__awaiting;
    if (!awaiting) return next();

    if (awaiting.kind === 'target') {
      const norm = normalizeChannel(ctx.message.text);
      if (!norm) {
        await ctx.reply('Невірний формат. Приклад: @siverradar');
        return;
      }
      store.updateSettings({ targetChannel: norm, alertsChannel: norm, __awaiting: null });
      await ctx.reply(`Target встановлено: ${norm}`);
      return;
    }

    return next();
  });

  // ---- Panel callbacks ----
  bot.action('PANEL_MODE_TOGGLE', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const s = store.getSettings();
    const nextMode = s.mode === 'manual' ? 'auto' : 'manual';
    store.updateSettings({ mode: nextMode });
    await ctx.answerCbQuery(`Mode: ${nextMode}`);
    await ctx.editMessageReplyMarkup(panelKeyboard(store).reply_markup);
  });

  bot.action('PANEL_SET_TARGET', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    store.updateSettings({ __awaiting: { kind: 'target' } });
    await ctx.answerCbQuery();
    await ctx.reply('Введи target канал (наприклад @siverradar) одним повідомленням.');
  });

  bot.action('PANEL_SOURCES', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const list = store.listSources();
    await ctx.answerCbQuery();
    await ctx.reply(list.length ? `Sources:\n${list.join('\n')}` : 'Sources порожні. Додай: /source_add @channel');
  });

  bot.action('PANEL_STATUS', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    await ctx.answerCbQuery();
    await showPanel(ctx, store);
  });

  bot.action('PANEL_QUEUE', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    await ctx.answerCbQuery();
    const items = store.queueListPending(5);
    if (!items.length) {
      await ctx.reply('Черга порожня.');
      return;
    }
    const text = items.map(i => `#${i.id} • ${i.source}\n${(i.formattedText || '').slice(0, 160)}`).join('\n\n');
    await ctx.reply(text);
  });

  bot.action('PANEL_REGION_CHERN', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const s = store.getSettings();
    const set = new Set(s.allowedRegions || []);
    if (set.has('chernihiv')) set.delete('chernihiv'); else set.add('chernihiv');
    store.updateSettings({ allowedRegions: [...set] });
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(panelKeyboard(store).reply_markup);
  });

  bot.action('PANEL_REGION_SUMY', async (ctx) => {
    if (!ctx.state.__isAdmin) return;
    const s = store.getSettings();
    const set = new Set(s.allowedRegions || []);
    if (set.has('sumy')) set.delete('sumy'); else set.add('sumy');
    store.updateSettings({ allowedRegions: [...set] });
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(panelKeyboard(store).reply_markup);
  });
}
