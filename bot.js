import 'dotenv/config';

import { Telegraf } from 'telegraf';

import { initStore } from './src/store.js';
import { registerAdminPanel } from './src/admin_panel.js';
import { startAirAlertsPoller } from './src/air_alerts.js';
import { startOsintReader } from './src/osint_reader.js';

// --- Required secrets (keep only secrets in .env) ---
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TG_BOT_TOKEN in .env');
  process.exit(1);
}

// Who can управлять ботом (только ты). Оставим в .env как секрет.
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
if (!ADMIN_ID) {
  console.error('Missing ADMIN_ID in .env (your Telegram numeric user id)');
  process.exit(1);
}

// MTProto (чтение источников через твою сессию)
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION_STRING = process.env.SESSION_STRING || '';
if (!API_ID || !API_HASH || !SESSION_STRING) {
  console.error('Missing API_ID/API_HASH/SESSION_STRING in .env (needed to read sources via your account session)');
  process.exit(1);
}

const store = initStore({ path: process.env.STORE_PATH || 'bot_store.json' });
const bot = new Telegraf(BOT_TOKEN);

// Register admin panel + commands
registerAdminPanel({ bot, store, adminId: ADMIN_ID });

// Air alert poller (твоя часть бота — НЕ УДАЛЯЕМ)
startAirAlertsPoller({ bot, store });

// OSINT reader (читает источники по user session и постит в target channel)
startOsintReader({ bot, store, adminId: ADMIN_ID, apiId: API_ID, apiHash: API_HASH, sessionString: SESSION_STRING });

bot.launch().then(() => {
  console.log('Bot launched');
}).catch((e) => {
  console.error('Bot launch error:', e?.message || e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
