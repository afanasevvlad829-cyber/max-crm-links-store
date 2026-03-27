# MAX CRM Links Store

Рабочий репозиторий для связки:
- Chrome/Edge extension для ALFACRM
- Cloudflare Worker + KV для централизованного хранения deep link (`phone -> deepLink`)

## Структура
- `max-links.json` — централизованное хранилище ссылок (legacy / backup)
- `projects/max-browser-extension` — расширение браузера
- `projects/max-links-api` — Cloudflare Worker API

## Быстрый запуск

### 1) Extension
1. Откройте `chrome://extensions`
2. Включите `Developer mode`
3. Нажмите `Load unpacked`
4. Выберите: `projects/max-browser-extension`

### 2) Worker API
```bash
cd projects/max-links-api
wrangler secret put API_TOKEN
npm run deploy
```

После deploy используйте URL вида:
`https://max-links-api.<subdomain>.workers.dev`

### 3) Связка extension <-> API
В панели MAX в extension:
- `API URL` -> вставить URL Worker
- `API key: задать` -> вставить `API_TOKEN`
- `Проверить API key`

## API контракты
- `GET /health`
- `GET /links?phone=7XXXXXXXXXX`
- `PUT /links` with JSON `{ "phone": "7XXXXXXXXXX", "deepLink": "https://web.max.ru/3940279" }`
- `DELETE /links?phone=7XXXXXXXXXX`

Все защищенные endpoints используют заголовок:
- `x-api-key: <API_TOKEN>`
