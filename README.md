# tg-siver-bot (manual/auto + OSINT + air alerts)

Тут 2 части:
1) **Повітряна тривога** (твоя стара логика, файл `districts.json` + `state.json`) — сохранено.
2) **OSINT reader**: читает источники (ТГК) через твою user-session и постит в твой канал.

## Быстрый запуск локально
1) Установи зависимости:
```bash
npm i
```
2) Скопируй `.env.example` → `.env` и заполни:
```bash
cp .env.example .env
```
3) Запуск:
```bash
npm start
```

## Управление в Telegram
1) Напиши боту в ЛС `/start`
2) Открой `/panel`
   - поставь **Target** (например `@siverradar`)
   - добавь **Sources** (`/source_add @channel`)
   - выбери режим **MANUAL/AUTO**

### Режимы
- **MANUAL**: всё идёт тебе на апрув (кнопки ✅/❌)
- **AUTO**: бот постит сам (без предохранителей), но с дедупом

## Важно
- Бот должен быть **админом** твоего канала (иначе не сможет постить).
- `TG_BOT_TOKEN`, `SESSION_STRING`, `API_ID`, `API_HASH` — **секреты**, их не коммить.