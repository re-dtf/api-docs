# WebSocket и обновления в реальном времени

Источники:
- Запись трафика сайта (HAR-файл `ws-sio.har`, хэндшейк переключения протокола `GET wss://ws-sio.dtf.ru/socket.io/?EIO=3&transport=websocket`, HTTP 101);
- Анализ продакшен-бандла фронтенда DTF (`index-BqBtcOmE.js`, `Comments-Cb3otFQx.js`, 2026-11-03);
- Живые тестовые подключения без авторизации к `wss://ws-sio.dtf.ru` (посты `5391123` и `5391180`, 2026-11-03) с получением входящих событий создания комментариев и реакций.

Спецификация OpenAPI: [openapi/realtime.yaml](../openapi/realtime.yaml).

## Коротко

1. DTF **не использует HTTP-поллинг** (периодические GET-запросы) для обновления комментариев, реакций и ленты.
2. Все обновления идут через постоянное WebSocket-соединение по протоколу **Socket.IO (Engine.IO v3)**:  
   `wss://ws-sio.dtf.ru/socket.io/?EIO=3&transport=websocket`
3. Авторизация для публичных каналов (комментарии, посты, лента, счетчики просмотров) **не требуется**: сокет принимает подписки от анонимных клиентов без токенов и кук.
4. Модель доставки: **Pub/Sub**. Клиент отправляет событие `subscribe` с именем канала, сервер транслирует события с типом `"event"`.

---

## 1. Протокол и жизненный цикл

Транспорт основан на Socket.IO поверх чистого WebSocket (`transports: ["websocket"]`).

### Хэндшейк и подключение

1. Клиент инициирует WebSocket-соединение:
   ```http
   GET wss://ws-sio.dtf.ru/socket.io/?EIO=3&transport=websocket
   Connection: Upgrade
   Upgrade: websocket
   Sec-WebSocket-Version: 13
   Origin: https://dtf.ru
   ```
2. Сервер возвращает HTTP 101 и немедленно отправляет текстовый фрейм Engine.IO пакета `0` (handshake):
   ```json
   0{"sid":"V1cOkhKSnahC_kCHquvB","upgrades":[],"pingInterval":25000,"pingTimeout":5000}
   ```
3. Сервер отправляет пакет `40` (подтверждение открытия сессии Socket.IO).

### Ping / Pong (Heartbeat)

* Сервер с интервалом `pingInterval` (около 25 секунд) шлёт фрейм `2` (Engine.IO ping).
* Клиент обязан ответить фреймом `3` (Engine.IO pong). При отсутствии ответа сервер разрывает соединение по таймауту.

### Переподключение (Reconnection)

В клиенте DTF настроены параметры восстановления связи:
* `reconnectionDelay`: 10 000 мс (начальная задержка);
* `reconnectionDelayMax`: 60 000 мс (максимальная задержка);
* `randomizationFactor`: 0.618 (рандомизация джиттера).

При событии `reconnect` клиент автоматически повторно шлёт `subscribe` на все ранее зарегистрированные каналы (`listenChannelsSubscribed()`).

---

## 2. Подписка и отписка

Взаимодействие построено на событиях Socket.IO:

* **Подписка на канал:**  
  Пакет `42["subscribe", {"channel": "<имя_канала>"}]`.
* **Отписка от канала:**  
  Пакет `42["unsubscribe", {"channel": "<имя_канала>"}]`.
* **Входящее сообщение от сервера:**  
  Приходит в виде пакета Socket.IO с именем `"event"`:
  ```json
  42["event", {
    "channel": "<имя_канала>",
    "data": {
      "type": "<тип_события>",
      ...
    }
  }]
  ```

---

## 3. Ветка комментариев поста

При открытии поста с идентификатором `{postId}` клиент подписывается одновременно на **два канала**:

```text
42["subscribe", {"channel": "api:v2:comments-{postId}"}]
42["subscribe", {"channel": "api:comments-{postId}"}]
```

> **Почему два канала?**  
> `api:v2:comments-{postId}` — основной современный канал для работы с деревом комментариев (создание, редактирование, донаты).  
> `api:comments-{postId}` — исторический канал v1: в нём сервер по-прежнему рассылает события реакций и голосов (`comment voted`).

В клиенте обрабатываются 5 типов событий (подробные схемы полей см. в [openapi/realtime.yaml](../openapi/realtime.yaml)):

### 3.1. `comment_created` (канал `api:v2:comments-{postId}`)

Сервер отправляет событие с **полным объектом комментария** (схема совпадает с [Comment](../openapi/shared/schemas.yaml)):

```json
{
  "channel": "api:v2:comments-5391180",
  "data": {
    "type": "comment_created",
    "comment": {
      "id": 69619057,
      "author": { "id": 25909, "name": "Имя", "avatar": { ... } },
      "date": 1793718854,
      "level": 0,
      "replyTo": 0,
      "text": "Текст комментария",
      "textMd": "Текст комментария",
      "likes": { "counterLikes": 0, "counterDislikes": 0, "isLiked": 0 },
      "reactions": { "counters": [ ... ], "reactionId": 0 },
      "entry": { "id": 5391180, "title": "Заголовок" }
    }
  }
}
```

**Поведение в дереве комментариев:**
* Если комментарий с таким `id` уже есть в сторе — игнорируется (защита от дублирования своего комментария).
* Если `level === 0` (корневой комментарий) и включена сортировка по дате (`Date`) — добавляется в начало дерева (`position: "top"`).
* При сортировке по популярности корневой комментарий добавляется в конец (`position: "bottom"`).
* Если `level > 0` (ответ) — монтируется под родительский узел с `id === replyTo`.

*(Канал `api:comments-{postId}` параллельно транслирует это же событие, но со старой схемой v1; сайт DTF его игнорирует).*

---

### 3.2. `comment voted` (канал `api:comments-{postId}`)

Дифференциал голоса/реакции на комментарии:

```json
{
  "channel": "api:comments-5391180",
  "data": {
    "type": "comment voted",
    "content_id": 5391180,
    "id": 69618801,
    "reactionId": 6,
    "fromReactionId": 0,
    "reactionCount": 1,
    "count": 4,
    "state": 1,
    "subsite_id": 2482137,
    "user_hash": 2482137
  }
}
```

* `id` — ID комментария.
* `reactionId` — код новой реакции (`1` — лайк, `22` — дизлайк, `6` — эмодзи и т.д.).
* `fromReactionId` — предыдущая реакция того же пользователя (`0`, если реакции не было).
* `reactionCount` — актуальное количество реакций `reactionId` у этого комментария.
* `count` — суммарное число всех реакций комментария.

---

### 3.3. `comment_edited` (канал `api:v2:comments-{postId}`)

В `data.comment` передаётся обновленный объект комментария. Клиент обновляет соответствующие поля в существующем узле дерева без изменения позиции.

---

### 3.4. `change_reply_count_for_second_level_comment` (канал `api:v2:comments-{postId}`)

Обновляет счетчик свернутых дочерних ответов ветки второго уровня (плашка «ещё N ответов»):

```json
{
  "channel": "api:v2:comments-5391180",
  "data": {
    "type": "change_reply_count_for_second_level_comment",
    "data": {
      "comment_id": 69618801,
      "reply_count": 5
    }
  }
}
```

---

### 3.5. `change_donation_amount_for_comment` (канал `api:v2:comments-{postId}`)

Обновляет сумму донатов у комментария:

```json
{
  "channel": "api:v2:comments-5391180",
  "data": {
    "type": "change_donation_amount_for_comment",
    "data": {
      "commentId": 69618801,
      "amount": 100
    }
  }
}
```

---

## 4. Другие каналы WebSocket DTF

В коде фронтенда DTF используются и другие каналы pub/sub (проверено по исходному коду веб-клиента; события с пометкой *не снималось на бэкенде* получены методом статического анализа):

| Канал | События | Описание |
| --- | --- | --- |
| `api` | `new_entry_published` | Новый опубликованный пост в общую ленту (`content_id`, `subsite_id`). |
| `api` | `content voted` | Изменение реакций/лайков у поста (`content_id`, `reactionId`, `reactionCount`). |
| `api` | `change_comment_count_for_content` | Обновление общего счетчика комментариев поста в ленте (`content_id`, `count`). |
| `api` | `change_donation_amount_for_content` | Обновление суммы донатов поста (`post_id`, `amount`). |
| `api` | `gift_sent` | Отправка подарка (`giftData`, `refererType: post/comment/user`). |
| `content-hits-mobile-{postId}` | `content viewed` | Живой счетчик просмотров поста (`hitsCount`) без перезагрузки. |
| `mobile:{userId}` *(не снималось)* | `PostLiked`, `CommentLiked`, `CommentAdded`, `CommentReplied`, `CommentMention`, `PostPublished`, `PlusGifted`, `CommentDonated`, `UserDonated`, `PostDonated`, `AchievementUnlocked`, `GiftReceived`, `ProSubscription` | Персональные уведомления колокольчика. |
| `m:{chatHash}` *(не снималось)* | `messenger_event` (`addMessage`, `messageEdited`, `messagesRemoved`, `counter`) | Мессенджер / личные сообщения. |
| `marketplace` *(не снималось)* | `payment_confirmed` | Подтверждение оплаты покупок в маркетплейсе DTF. |

---

## 5. Пример подключения на чистом JS

```javascript
const postId = 5391180;
const ws = new WebSocket('wss://ws-sio.dtf.ru/socket.io/?EIO=3&transport=websocket');

ws.onopen = () => {
  console.log('Подключено к WebSocket DTF');
};

ws.onmessage = (event) => {
  const msg = event.data;

  // 1. Handshake Engine.IO (пакет 0) -> шлем подписки на каналы
  if (msg.startsWith('0')) {
    ws.send('42' + JSON.stringify(['subscribe', { channel: `api:v2:comments-${postId}` }]));
    ws.send('42' + JSON.stringify(['subscribe', { channel: `api:comments-${postId}` }]));
  }
  // 2. Heartbeat (пакет 2) -> шлем pong (пакет 3)
  else if (msg === '2') {
    ws.send('3');
  }
  // 3. Socket.IO события (пакет 42)
  else if (msg.startsWith('42')) {
    const [, payload] = JSON.parse(msg.slice(2));
    const channel = payload?.channel;
    const type = payload?.data?.type;
    console.log(`[${channel}] ${type}:`, payload.data);
  }
};
```
