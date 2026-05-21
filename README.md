# x-scraper-bot

X/Twitter Scraper to WhatsApp Channel Bot. Auto-reposts tweets from one or more
public X accounts into a WhatsApp channel via the
[WAHA](https://waha.devlike.pro/) HTTP API.

## Overview

The bot runs in a single Node.js process on a fixed-interval schedule:

1. Open each target X profile in a headless Puppeteer browser.
2. Extract recent tweets from the timeline DOM.
3. Filter out replies, retweets, off-topic posts, and tweets we have already
   seen (dedup is keyed on the X status id, persisted in SQLite).
4. POST each new tweet to the WAHA `sendText` endpoint, which forwards it to
   the configured WhatsApp channel.

State is local: a SQLite database at `./data/bot.db` and JSON-line logs at
`./logs/bot.log`. Both directories are created on first run.

## Architecture

```
   +------------------+        +------------------+        +-----------------+
   |   X / Twitter    | <----> |  Puppeteer page  | -----> |     bot.js      |
   |  public profile  |  HTML  |  (Chromium)      |  data  |  (Node.js)      |
   +------------------+        +------------------+        +--------+--------+
                                                                    |
                                              dedup + persist       |
                                                                    v
                                                          +-------------------+
                                                          |   ./data/bot.db   |
                                                          |     (SQLite)      |
                                                          +-------------------+
                                                                    |
                                                       formatted text message
                                                                    v
                                                          +-------------------+
                                                          |  WAHA HTTP API    |
                                                          |  /api/sendText    |
                                                          +---------+---------+
                                                                    |
                                                                    v
                                                          +-------------------+
                                                          | WhatsApp channel  |
                                                          +-------------------+
```

## Prerequisites

- Node.js 20 or later (the Docker image pins `node:20-slim`).
- Docker and `docker-compose` for the WAHA + bot stack (recommended).
- A WhatsApp account that you can scan a QR code from. WAHA logs in with that
  account once and reuses the session.
- A WhatsApp channel you administer, with its newsletter id (looks like
  `123456789@newsletter`).

## Quick start (docker-compose)

```bash
cp .env.example .env
# edit .env: at minimum set TARGET_ACCOUNTS and WAHA_CHANNEL_ID
docker-compose up -d
```

The first time WAHA boots, open `http://localhost:3000` in a browser and scan
the QR code with the phone that owns the WhatsApp channel. Once the WAHA
session reports `state=CONNECTED`, list your channels to find the channel id:

```bash
curl http://localhost:3000/api/default/channels
```

Copy the matching `id` (format `<digits>@newsletter`) into `.env` as
`WAHA_CHANNEL_ID`, then restart the bot service:

```bash
docker-compose restart bot
docker-compose logs -f bot
```

## Local development

```bash
npm install
cp .env.example .env
# edit .env with real values
npm run dev   # runs bot.js under nodemon
```

Note: when running on the host (not in Docker), Puppeteer downloads its own
Chromium build the first time. If you prefer a system Chromium, set
`PUPPETEER_EXECUTABLE_PATH` in your shell.

## Configuration

Every variable below is read from `.env` (loaded by `dotenv`). The Docker
image and `docker-compose.yml` forward the same names.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_ACCOUNTS` | (required) | Comma-separated list of X usernames to monitor. Leading `@` is allowed and stripped. Example: `elonmusk,whale_alert`. |
| `FILTER_KEYWORDS` | empty | Comma-separated keywords. If non-empty, only tweets whose text contains at least one keyword (case-insensitive) are posted. |
| `SKIP_REPLIES` | `true` | If `true`, drop tweets that are replies to other users. |
| `SKIP_RETWEETS` | `true` | If `true`, drop retweets and posts whose URL path username does not match the requested account (defends against pinned reposts). |
| `WAHA_URL` | `http://localhost:3000` | Base URL of the WAHA server. In docker-compose this is `http://waha:3000`. |
| `WAHA_SESSION` | `default` | WAHA session name. Must match the session you scanned the QR code into. |
| `WAHA_CHANNEL_ID` | (required) | Target WhatsApp channel id, e.g. `123456789@newsletter`. Cara ambil: lihat Quick start di atas. |
| `CHECK_INTERVAL_MINUTES` | `5` | Minutes between scrape cycles. Clamped to a minimum of `1`. |
| `MESSAGE_DELAY_MS` | `5000` | Delay between consecutive WAHA sends, in milliseconds. Clamped to a minimum of `1000`. |
| `MAX_TWEETS_PER_CHECK` | `5` | Maximum number of new tweets posted per account per cycle. |
| `HEADLESS` | `true` | Run Chromium headless. Set to `false` for local debugging only. |
| `PUPPETEER_EXECUTABLE_PATH` | unset | Path to a system Chromium binary. The Docker image sets this to `/usr/bin/chromium`. |

## Testing

The repo ships a small smoke-test CLI in `test.js`:

```bash
npm test -- test:waha       # check WAHA session state and engine
npm test -- test:scraper    # open a non-headless browser and dump tweets
npm test -- test:send       # send a test message to WAHA_CHANNEL_ID
npm test -- stats           # show counts and recent rows from ./data/bot.db
npm test -- logs            # tail the last 50 JSON-line records from ./logs/bot.log
```

The bot itself can be sanity-checked without launching anything:

```bash
node --check bot.js
TARGET_ACCOUNTS=elonmusk WAHA_CHANNEL_ID=123@newsletter \
  node -e "console.log(Object.keys(require('./bot.js')).sort().join(','))"
```

## Troubleshooting

- **Chromium fails to launch (`Failed to launch the browser process`).** The
  host is missing shared libraries. Either install the apt packages listed in
  the `Dockerfile` (`libnss3`, `libxcomposite1`, `libgbm1`, ...) or run the bot
  inside Docker, where the image already has them.
- **WAHA session state is not `CONNECTED`.** Open `http://localhost:3000` and
  rescan the QR code with the phone that owns the channel. The session is
  persisted in the `waha_data` volume; deleting that volume forces a re-pair.
- **Posts are sporadic / WAHA drops messages.** Raise `CHECK_INTERVAL_MINUTES`
  and/or `MESSAGE_DELAY_MS`. WhatsApp aggressively rate-limits broadcast-style
  channels; sustained traffic above ~1 message per 5 seconds gets throttled.
- **X shows a login wall ("Sign in to X").** The bot best-effort dismisses the
  popup via `[data-testid="app-bar-close"]`, but some accounts and IP ranges
  are forced to log in. If you hit this, slow down `CHECK_INTERVAL_MINUTES`
  and rotate the egress IP. There is no in-bot login flow.
- **`SQLITE_BUSY` or `database is locked`.** Only one bot process should write
  to `./data/bot.db`. If you ran a stale instance, stop it and restart.

## Deployment

- **docker-compose:** the included `docker-compose.yml` brings up WAHA and the
  bot together and persists `./data` and `./logs` as bind mounts.
- **Railway:** `railway.json` selects the Dockerfile builder and runs
  `node bot.js`. Set the env vars in the Railway dashboard. WAHA must be
  reachable from the bot container; the simplest setup is to run WAHA in the
  same project and point `WAHA_URL` at its private URL.

## Disclaimer

Scraping X / Twitter without authentication may violate the platform's Terms
of Service. This project is provided as-is, for personal and educational use.
You are responsible for any access you make. Reposting third-party content to
your WhatsApp channel must comply with copyright and the channel rules.
