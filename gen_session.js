import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

if (!apiId || !apiHash) {
  console.log("❌ Нужны API_ID и API_HASH в env");
  process.exit(1);
}

const session = new StringSession(""); // пустая = создаём новую
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

(async () => {
  console.log("🔐 Login to Telegram аккаунт (тот, где ты подписан на ТГК)");
  await client.start({
    phoneNumber: async () => await input.text("Phone (+380...): "),
    password: async () => await input.text("2FA password (если есть): "),
    phoneCode: async () => await input.text("Code from Telegram: "),
    onError: (err) => console.log("Login error:", err),
  });

  const me = await client.getMe();
  console.log("✅ Logged in as:", me.username ? `@${me.username}` : me.firstName, me.id?.toString?.() ?? me.id);

  const str = client.session.save();
  console.log("\n=== SESSION_STRING (KEEP SECRET) ===\n");
  console.log(str);
  console.log("\n=== END ===\n");

  await client.disconnect();
})();

