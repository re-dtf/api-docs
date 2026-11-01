# Авторизация в API DTF

Источники: записи трафика сайта (HAR, там нет запросов входа и обновления, но видны токены, куки и заголовки), живые запросы 2026-11-02 (без учётных данных и с токенами запасного аккаунта) и работающий клиент reDTF. Что не подтверждено, помечено «не проверено».

## Коротко

1. Вход: `POST /v3.4/auth/email/login` (почта + пароль) → `accessToken` и `refreshToken`.
2. Запросы: заголовок `JWTAuthorization: Bearer <accessToken>`.
3. Access-токен живёт **5 минут**. Новый выдаёт `POST /v3.4/auth/refresh` с полем `token`.
4. `/v3.*` не отдаёт CORS-заголовки для чужих сайтов, поэтому вход и обновление из браузера на стороннем домене идут **через прокси**. Остальные запросы — напрямую.

## Токены и куки

| Что | Где | Что это |
| --- | --- | --- |
| access-токен | заголовок `JWTAuthorization` | JWT HS256 на 5 минут; нужен каждому запросу с данными пользователя |
| refresh-токен | ответ входа и обновления; в браузере кука `auth-refresh-remember` | 64 hex-символа, живёт около 60 суток; обменивается на access-токен |
| `osnova-aid` | кука | 24 символа, не JWT. Идентификатор устройства: сервер выдаёт его любому посетителю. Пользователя не определяет: ни как токен, ни как кука запросы с данными не авторизуются (401) |
| `osnova-remember` | кука | 64 hex-символа, «запомнить меня»; как её принимает сервер, не изучалось |

## Вход

```http
POST https://api.dtf.ru/v3.4/auth/email/login
Content-Type: multipart/form-data

email=…&password=…
```

- Успех: сессия `{ type, accessToken, refreshToken, accessExpTimestamp, refreshExpTimestamp }`. Успешный ответ входа не снимался; обновление токена возвращает ту же сессию в обёртке `{ message, data }`, вероятно и здесь так же (не проверено).
- Неверная пара: **HTTP 400**, `{ "message": "Invalid login or password", "code": 104, "data": null }`.
- Ошибки API v3 имеют форму `{ message, code, data }`, не `{ message, error: { code, info } }` как в v2.

Вход через соцсети, регистрация, сброс пароля, смена почты, выход не изучались.

## Обновление токена

```http
POST https://api.dtf.ru/v3.4/auth/refresh
Content-Type: multipart/form-data

token=<refreshToken>
```

- Успех: HTTP 200 и тело
  ```json
  { "message": "…", "data": { "type": "Bearer", "accessToken": "<jwt>", "accessExpTimestamp": 0, "refreshToken": "<64 hex>", "refreshExpTimestamp": 0 } }
  ```
  Токены лежат в `data`. В заголовках ответа их нет. Ответ ставит куку `auth-refresh-remember`.
- Сроки: `accessExpTimestamp` через 300 секунд, `refreshExpTimestamp` через около 60 суток.
- Каждое обновление выдаёт новый refresh-токен. Предыдущий после этого продолжал работать: повторный вызов с ним тоже вернул 200 (проверено однократно, срок действия предыдущего токена не измерялся).
- Неизвестный, просроченный или отозванный токен: **HTTP 404**, `{ "message": "Refresh session not found", "code": 105, "data": null }`.
- Полученный access-токен принимается: `GET /v2.31/subsite/me?markdown=false` отвечает 200 с профилем.

## Access-токен

JWT HS256, живёт **300 секунд** (`exp − iat`). Подпись проверить нельзя, токен считайте непрозрачным; содержимое пригодится для отладки.

| Claim | Смысл |
| --- | --- |
| `jti`, `iat`, `exp` | стандартные |
| `user_id`, `subsite_id` | id пользователя и его личного подсайта |
| `role` | число, в снятом токене `0` |
| `name`, `email` | имя и почта пользователя (**личные данные в токене**) |
| `banned` | `true`, если пользователь заблокирован |

## Как отправлять токен

```http
JWTAuthorization: Bearer <accessToken>
```

Сайт добавляет ещё `pwa: 1`. Нужен ли он, не проверялось.

CORS разрешает заголовки (`Access-Control-Allow-Headers`): `Accept, JWTAuthorization, Authorization, Cache-Control, Content-Type, DNT, If-Modified-Since, Keep-Alive, Origin, User-Agent, X-Mx-ReqToken, X-Requested-With, X-JS-Version, X-This-Is-CSRF, Pwa, X-Device-Token`. Для авторизованных запросов используется только `JWTAuthorization`.

### Как держать сессию

Запрос с просроченным access-токеном отвечает 401. Клиент один раз обновляет токен и повторяет запрос; если обновление вернуло ошибку, сессия закончилась и нужен новый вход. Заранее обновлять по `accessExpTimestamp` необязательно.

## CORS и прокси

Запросы `OPTIONS` с чужим `Origin`:

| Путь | Ответ |
| --- | --- |
| `/v3.4/auth/email/login`, `/v3.4/auth/refresh` | 204 **без** `Access-Control-Allow-Origin`: браузер заблокирует |
| `/v2.31/feed`, `/v2.31/subsite/me` | 204 с `Allow-Origin` = источнику запроса и `Allow-Credentials: true` |
| `GET /v2.31/feed` с чужим `Origin` | 200, `Allow-Origin` = источнику |

Прокси нужен только для `/v3.*`. Прокси reDTF (`reDTF-proxy`, Cloudflare Worker, около 30 строк) пересылает запрос на `api.dtf.ru` без изменений и добавляет `Access-Control-Allow-Origin: *`. Он видит пароль и токены в открытом виде, поэтому пользователь указывает его адрес сам; запросы с данными через прокси не идут.

## Блокировка пользователя

- В access-токене `banned: true`; в профиле `isBanned` и `bannedInfo`.
- Чтение (лента, посты, комментарии) работает, 200.
- Действия (реакции) отвечают **403** `{ "message": "USER_BANNED", "error": { "code": 403, "info": { "errorCode": "USER_BANNED" } } }`.
- В посте и профиле `commentEditor.enabled = false`, есть `text` (с оставшимся временем), `reason`, `until` (Unix-время).
- В уведомлениях блокировка — тип `8`, иконка `lock`; `meta.entityId` — id удалённого комментария, который отдаёт `GET /v2.1/comment/banned/{id}`.

## Не проверено

1. Форма успешного ответа входа по почте.
2. Нужен ли заголовок `pwa: 1`.
3. Работает ли пара кук `osnova-aid` + `osnova-remember`.
4. Ключ `auth-refresh-token` (JSON `{ "token", "expTimestamp" }`) в браузере: где лежит и совпадает ли `token` с `auth-refresh-remember`.

## Безопасность

- Токены отправляются только на `api.dtf.ru`, `upload.dtf.ru` и на прокси клиента.
- HAR-файлы содержат живые токены, куки и чужие данные. В репозиторий они не попадают (`.gitignore`); в спецификации только обезличенные примеры.
