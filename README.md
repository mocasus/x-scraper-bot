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

## CLI

The repo ships an ops CLI at `cli.js` that wraps the same env, logger, and
SQLite handles the scheduler uses. The three equivalent ways to run it:

```bash
npx x-scraper start           # after `npm install` wires the bin
node cli.js start             # direct invocation
npm run cli -- start          # via the npm-script wrapper
```

`node bot.js` (and `npm start`) remain the canonical scheduler entrypoint and
are unchanged; the CLI is additive.

### CLI reference

| Command | Description | Flags |
| --- | --- | --- |
| `start` | Run the scrape -> WAHA scheduler. Validates `TARGET_ACCOUNTS` and `WAHA_CHANNEL_ID` first. | `--once` (run a single cycle then exit) |
| `scrape <username>` | Open one X profile in puppeteer and print the scraped tweets. Does not touch the DB or WAHA. | `--limit <n>`, `--json`, `--dry-run` |
| `send <text>` | Send a one-off text to the configured WAHA channel. | `--channel <id>` (override `WAHA_CHANNEL_ID`) |
| `health` | GET `${WAHA_URL}/api/sessions/${WAHA_SESSION}`; exit 0 only when `state=CONNECTED`. | `--json` |
| `stats` | Print SQLite tweet counts and the 5 most recent rows from `./data/bot.db`. | `--json` |
| `logs` | Pretty-print the last N JSON-line records from `./logs/bot.log`. | `-n, --lines <n>` (default 50), `-f, --follow` |
| `accounts list` | Print the parsed `TARGET_ACCOUNTS` list from `.env`. | (none) |
| `accounts add <username>` | Append a username to `TARGET_ACCOUNTS` in `.env` (deduplicated, case-insensitive). | (none) |
| `accounts remove <username>` | Drop a username from `TARGET_ACCOUNTS` in `.env` (case-insensitive). | (none) |
| `db migrate` | Ensure the `tweets` table exists. Idempotent. | (none) |
| `db reset` | Drop and recreate the `tweets` table. Refuses without `--confirm`. | `--confirm` |
| `dashboard` | Open the TUI dashboard for live monitoring. Requires a TTY. Alias: `tui`. | `--refresh <seconds>` (default `15`) |

### CLI examples

```bash
# Run a single scrape -> post cycle and exit
node cli.js start --once

# Scrape one account and inspect the JSON output without touching the DB or WAHA
node cli.js scrape elonmusk --json --dry-run
node cli.js scrape elonmusk --json --limit 3

# Smoke-test the WAHA session
node cli.js health
node cli.js health --json

# Show DB stats and recent rows
node cli.js stats

# Edit your watchlist without re-opening .env
node cli.js accounts list
node cli.js accounts add whale_alert
node cli.js accounts remove cryptoanalyst

# Wipe the dedup table after a failed first run
node cli.js db reset --confirm
```

## Testing

```bash
npm test                # runs node --test against test/**/*.test.js
npm run test:coverage   # same suite with --experimental-test-coverage
```

The suite never opens a real network socket, never launches puppeteer, and
never writes to `./data/bot.db` or `./logs/bot.log` (it uses `:memory:`
SQLite and `os.tmpdir()` log files). It is safe to run with no `.env`
file present:

```bash
node --check bot.js
node --check cli.js
TARGET_ACCOUNTS=elonmusk WAHA_CHANNEL_ID=123@newsletter \
  node -e "console.log(Object.keys(require('./bot.js')).sort().join(','))"
```

## Dashboard

The `dashboard` subcommand opens a developer TUI on top of the same SQLite
database and JSON-line log file the scheduler reads. It is observer-mode: it
does not start the scraper, post to WAHA, or mutate the DB. You can run it
concurrently with `node bot.js` because SQLite is opened in WAL mode and the
log file is tailed read-only.

```bash
npm run dashboard                       # equivalent to: node cli.js dashboard
node cli.js dashboard --refresh 5       # refresh panels every 5 seconds
node cli.js tui                         # short alias
```

The dashboard requires a real TTY. If `stdout` is not a TTY (when piped to a
file, run inside CI, or invoked over a non-interactive SSH session) the
process prints `dashboard requires a TTY (run from an interactive terminal;
not pipeable)` to stderr and exits with code `1`. Run it inside `tmux` or
`screen` for a remote SSH session.

```
+--------------------+----------------+----------------------------------+
| Status             | Today          | Tweets/hr (last 24h)             |
|  WAHA   CONNECTED  |  Scraped  12   |   ^                              |
|  Accounts 4        |  Posted    9   |   |    .                         |
|  Uptime  1h 23m    |  Pending   3   |   |   .  .   .                   |
+--------------------+----------------+----------------------------------+
| Accounts (last seen)              | Recent tweets                       |
|  @elonmusk         2m              |  OK @elonmusk 2m   GPU prices ...   |
|  @whale_alert      11m             |  -- @whale_alert 11m  USDT mint ... |
|  @cryptoanalyst    3h              |  OK @elonmusk 19m  Mars colony ...  |
+-----------------------------------+-------------------------------------+
| Logs (live)                                                              |
|  [12:03:01] [INFO]: cycle complete; 3 new tweets posted                  |
|  [12:03:04] [WARN]: rate-limited by WAHA, sleeping 5s                    |
|  [12:03:09] [INFO]: posted https://x.com/elonmusk/status/1742...         |
|                                                                          |
+--------------------------------------------------------------------------+
| ?:help  q:quit  r:refresh  s:scrape  a:accounts  c:clear                 |
+--------------------------------------------------------------------------+
```

### Keybindings

| Key | Action |
| --- | --- |
| `q`, `Ctrl+C` | Quit and clean up (intervals stop, DB closes, log tail detaches). |
| `r` | Refresh every panel immediately (does not wait for the next interval tick). |
| `s` | Spawn `node cli.js scrape <first TARGET_ACCOUNT> --json --limit 5` as a child process; both stdout and stderr stream into the live logs panel with a `[scrape]` prefix. |
| `a` | Open a prompt to add or remove a target account; reuses the same `accounts add` / `accounts remove` logic, including the X-handle alphabet validation. |
| `c` | Clear the on-screen logs panel and the in-memory ring buffer. The on-disk log file (`./logs/bot.log`) is not modified. |
| `?`, `h` | Show the help modal listing every keybinding. |
| Arrow keys, `PgUp`, `PgDn` | Scroll the live logs panel (delegated to blessed-contrib's log widget). |

### Notes and limitations

- The dashboard cannot be piped to a file. Running `node cli.js dashboard >
  out.txt` exits with code `1` and the TTY guard message above.
- For SSH sessions, run inside `tmux` or `screen` so the layout survives
  disconnects and the underlying TTY is preserved across reconnects.
- Panel refresh defaults to 15 seconds; the `Uptime` field updates every
  second via a separate lightweight interval. Lower the panel cadence with
  `--refresh 5` if you want sub-15s feedback while debugging a scrape cycle.
- The dashboard is a developer tool. The Docker image's `CMD` is still
  `["node", "bot.js"]` and Railway runs the scheduler, not the TUI.

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
