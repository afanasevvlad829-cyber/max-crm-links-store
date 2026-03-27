# ALFACRM Max Contact Link

## Что делает
Добавляет иконку Max рядом с иконками мессенджеров (WhatsApp/Telegram) в карточке клиента ALFACRM (`customer/view`), проверяет наличие номера в Max через GREEN-API и подсвечивает статус.

Поддерживает захват deep link:
- клик по иконке Max сохраняет текущий номер как `pending`;
- в `max.ru` показывается панель, которая помогает вставить номер в поиск;
- после открытия нужного чата ссылка сохраняется автоматически (кнопка `Сохранить ссылку` остается как ручной fallback);
- дальше для этого номера в CRM будет открываться сохраненный deep link.

## Быстрый запуск
1. Откройте `chrome://extensions` (или `edge://extensions`).
2. Включите `Developer mode`.
3. Нажмите `Load unpacked`.
4. Выберите папку: `/Users/vladimirafanasev/Max/max-browser-extension`.
5. Откройте карточку клиента и обновите страницу.

## Статус иконки
- Желтый: проверка номера в процессе.
- Зеленый: номер найден в Max.
- Красный: номер не найден в Max.
- Серый: проверка временно недоступна (ошибка API/сети/авторизации инстанса).

## Настройка GREEN-API
В `content.js`:
- `GREEN_API_URL` — `apiUrl` из кабинета GREEN-API.
- `GREEN_API_ID_INSTANCE` — `idInstance`.
- `GREEN_API_TOKEN_INSTANCE` — `apiTokenInstance`.
- `MAX_LINK_BASE` — базовый URL веб-клиента Max (рекомендуется `https://max.ru`, ссылка формируется как `https://max.ru/+7...`).

## Настройка Cloudflare Store (общая база ссылок)
В `content.js`:
- `CLOUD_API_BASE_URL` — URL Worker, например `https://max-links-api.afanasevvlad829.workers.dev`
- `API key` (секрет `API_TOKEN`) задается через кнопку `API key: задать` в панели MAX.

Как работает:
- при сохранении ссылки в MAX расширение сохраняет локально и отправляет в Cloud API;
- при открытии карточки ссылка читается локально, а если нет — запрашивается из Cloud API по номеру;
- в панели MAX есть кнопки `API key: задать`, `Проверить API key` и `API URL`.

## Дополнительно
- В `data-max-chat-id` сохраняется `chatId` из GREEN-API (формат вида `100...`).
- В `data-max-cus-chat-id` сохраняется `chatId` для отправки сообщений по номеру (формат `7XXXXXXXXXX@c.us`).
- `MAX_LOOKUP_URL_TEMPLATE` можно использовать как альтернативу GREEN-API (если нужен свой backend lookup).
- Маппинг `номер -> deep link` хранится в `chrome.storage.local` (`maxDeepLinksByPhone`).
