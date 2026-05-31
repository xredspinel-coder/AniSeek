# AniSeekBot

AniSeekBot is the Telegram webhook service for AniSeek. It is intentionally independent from the dashboard and talks directly to Firebase Firestore through the Firebase Admin SDK.

## Runtime

- Node.js 20+
- Express webhook server
- node-telegram-bot-api without polling
- Firebase Admin SDK
- trace.moe for scene recognition
- AniList GraphQL for the real anime title from the `anilist` id

## Environment

Copy `.env.example` to `.env` and fill:

```env
BOT_TOKEN=
BASE_URL=
DASHBOARD_ORIGIN=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

`DASHBOARD_ORIGIN` is optional and can be a comma-separated list of dashboard origins allowed to call `GET /telegram/file-url`. If it is omitted, that resolver endpoint returns `Access-Control-Allow-Origin: *`. `FIREBASE_PRIVATE_KEY` may contain escaped newlines (`\n`). Runtime settings such as `dailyLimit` and `maintenanceMode` are not read from `.env`; they are read from `settings/global` in Firestore.

## Local Development

```bash
npm install
npm run dev
```

The server listens on `http://localhost:8080` and receives Telegram updates at `POST /telegram/webhook`.

The dashboard media resolver is available at `GET /telegram/file-url?fileId=TELEGRAM_FILE_ID`. It asks Telegram for the current file path and returns a Telegram file URL without storing media in Firebase Storage.

`npm run dev` is a long-running local server command. Stop it with `Ctrl+C` when finished.

## Webhook

Expose the bot with a public URL, set `BASE_URL`, then run:

```bash
npm run set:webhook
```

The bot never starts polling.

## Deployment

Deploy this folder by itself. For Render, use:

```text
Root Directory: AniSeekBot
Build Command: npm install
Start Command: npm run start
```

The dashboard is not required on the bot host.

## Limits And Logging

For every user message, the bot reads settings through the TTL cache, reads or creates `users/{telegramId}`, and checks:

- `maintenanceMode`
- `isBlocked`
- `dailyLimit`
- `dailyLimitOverride`
- `unlimitedUntil`
- `isAdmin`

If a request reaches trace.moe/AniList analysis, the bot writes normal user-facing outcomes to `activities/{activityId}`. Successful matches use `status: "success"`, low-confidence matches use `status: "low_similarity"`, and trace responses with no match use a rejected activity with `rejectionReason: "no_match"`.

Technical failures such as `invalid_media`, `unsupported_source`, `invalid_url`, `processing_error`, `telegram_download_error`, and `trace_api_error` are written to `errors/{errorId}` instead of normal activity documents.

Attempts that reach the analysis step increment `dailyUsed`.

## Settings Cache

Every user message calls `getSettings()`. That function returns cached settings when the cache is younger than 60 seconds. If the cache is missing or expired, it reads `settings/global` once from Firestore and updates the local cache. If Firestore is missing or unavailable, the bot falls back to the default settings in `src/config/defaultSettings.js`.

There is no background polling, no interval, and no Firestore watcher.
