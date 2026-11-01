# Что проверено

Живые запросы без токена, 2026-11-02.

## Работает без токена (200)

| Эндпоинт | Заметка |
| --- | --- |
| `GET /v2.31/feed`, `/v2.10/feed`, `/v2.1/feed` | курсор разный, см. `conventions.md` |
| `GET /v2.31/news`, `/v2.31/news/min` | `news` — по порциям, `news/min` — пять штук массивом |
| `GET /v2.31/timeline` | записи подсайта |
| `GET /v2.31/subsite`, `/v2.7/subsite` | v2.31 в обёртке `{ role, subsite }`, v2.7 плоско |
| `GET /v2.31/subsite/subscribers`, `/subscriptions` | у подписок постраничность `nextPage` |
| `GET /v2.31/content`, `/v2.10/content` | |
| `GET /v2.10/comments`, `/v2.31/comments` | на v2.31 только `items`, без `editor` и `lastVisit` |
| `GET /v2.31/search` | |
| `GET /v2.31/rating` | отвечает `{ tabs, subsites }`, не изучался |

## Требует токен (без него 401)

`GET /v2.31/subsite/me` и всё, что в `openapi/` помечено `security: [{ JWTAuthorization: [] }]`.

## Не описано

Закладки и избранное, репосты, подписка и отписка, смена имени, донаты, **добавление комментария**, онбординг, смена пароля и почты, социальные входы, регистрация. Для них нет HAR и работающего вызова в reDTF, поэтому в `openapi/` их нет. Сначала снимите HAR.

## Как перепроверить

Публичные методы: обычные GET без заголовков, например `curl "https://api.dtf.ru/v2.31/feed?pageName=popular&sorting=hotness"`. Методы с токеном сверяйте через DevTools сайта DTF (Network → Fetch/XHR), HAR сохраняйте **локально** и в репозиторий не добавляйте.
