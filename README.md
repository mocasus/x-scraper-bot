<div align="center">

```
   __  __        ____                                  ____        _
   \ \/ /       / ___|  ___ _ __ __ _ _ __   ___ _ __ | __ )  ___ | |_
    \  /  ____  \___ \ / __| '__/ _` | '_ \ / _ \ '__||  _ \ / _ \| __|
    /  \ |____|  ___) | (__| | | (_| | |_) |  __/ |   | |_) | (_) | |_
   /_/\_\       |____/ \___|_|  \__,_| .__/ \___|_|   |____/ \___/ \__|
                                     |_|
```

*Auto-repost tweet dari X/Twitter ke WhatsApp Channel — scraper Puppeteer + WAHA, lengkap dengan CLI dan TUI dashboard.*

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white) ![Puppeteer](https://img.shields.io/badge/Puppeteer-21.x-40B5A4?logo=puppeteer&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white) ![CLI](https://img.shields.io/badge/CLI-commander.js-orange) ![TUI](https://img.shields.io/badge/TUI-blessed-9cf) ![WhatsApp](https://img.shields.io/badge/WhatsApp-WAHA-25D366?logo=whatsapp&logoColor=white) ![License](https://img.shields.io/badge/license-MIT-blue) ![Tests](https://img.shields.io/badge/Tests-158%20passing-success)

</div>

---

## Daftar Isi

1. [Tentang Project](#tentang-project)
2. [Fitur Utama](#fitur-utama)
3. [Tech Stack](#tech-stack)
4. [Arsitektur](#arsitektur)
5. [Persyaratan](#persyaratan)
6. [Quick Start (Docker Compose)](#quick-start-docker-compose)
7. [Quick Start (Manual / Lokal)](#quick-start-manual--lokal)
8. [Konfigurasi](#konfigurasi)
9. [Referensi CLI](#referensi-cli)
10. [Dashboard TUI](#dashboard-tui)
11. [Testing](#testing)
12. [Hosting Gratis 24/7](#hosting-gratis-247)
13. [Deployment](#deployment)
14. [Troubleshooting](#troubleshooting)
15. [Roadmap](#roadmap)
16. [Berkontribusi](#berkontribusi)
17. [Lisensi](#lisensi)
18. [Disclaimer](#disclaimer)

---

## Tentang Project

**x-scraper-bot** adalah bot Node.js yang otomatis nge-repost tweet dari satu atau beberapa akun X/Twitter publik ke sebuah WhatsApp Channel. Scraping dilakukan via Puppeteer headless (gratis, tanpa harus bayar X API resmi yang $100/bulan), dedup berbasis SQLite (status id sebagai primary key), lalu pesan dikirim ke channel via [WAHA](https://waha.devlike.pro/) HTTP API.

Project ini sengaja didesain *single-tenant*: satu instance bot melayani satu akun WhatsApp dan satu (atau beberapa) channel yang dimiliki akun itu. Cocok buat individu, komunitas kecil, atau organisasi yang mau auto-curate timeline tertentu ke channel WhatsApp tanpa drama infra cloud yang ribet.

## Fitur Utama

- 👥 **Multi-akun scraping** monitor beberapa akun X sekaligus dari satu proses.
- 🧠 **Anti-duplikasi** via SQLite (`status_id` unique), aman direstart kapan saja.
- 🔁 **Retry-aware** kegagalan WAHA dilog dan dilewati, tidak nge-block siklus berikutnya.
- 🔎 **Filter keyword** post hanya yang match (case-insensitive), opsional.
- 🚫 **Skip replies & retweets** filter default ON, bisa dimatikan via env.
- ⏱️ **Scheduler bawaan** interval default 5 menit, fully configurable.
- 🛠️ **CLI lengkap** `start`, `scrape`, `send`, `health`, `stats`, `logs`, `accounts`, `db`, `dashboard`.
- 📺 **TUI Dashboard** monitoring real-time pakai blessed + blessed-contrib.
- 🐳 **Docker Compose ready** WAHA + bot dalam satu stack, satu perintah jalan.
- 🚂 **Railway support** `railway.json` siap deploy ke trial Railway.
- ✅ **158 unit test** node:test built-in, eksekusi <1 detik, no external framework.
- 📜 **JSON-line logging** ke `./logs/bot.log`, gampang di-tail dan di-grep.

## Tech Stack

| Layer | Tools | Versi |
| --- | --- | --- |
| Runtime | Node.js | 20+ |
| Scraping | Puppeteer | ^21.5 |
| Storage | better-sqlite3 (WAL mode) | ^9.4 |
| HTTP client | axios | ^1.6 |
| CLI parser | Commander.js | ^12.1 |
| TUI | blessed + blessed-contrib | ^0.1.81 / ^4.11 |
| Config | dotenv | ^16.3 |
| Testing | node:test (built-in) | bawaan Node 20+ |
| WhatsApp gateway | WAHA Plus | latest (Docker image) |
| Container | Docker + docker compose | v2 plugin |

## Arsitektur

```
   +------------------+        +------------------+        +-----------------+
   |   X / Twitter    | <----> |  Puppeteer page  | -----> |     bot.js      |
   |  profil publik   |  HTML  |  (Chromium)      |  data  |  (Node.js)      |
   +------------------+        +------------------+        +--------+--------+
                                                                    |
                                              dedup + persist       |
                                                                    v
                                                          +-------------------+
                                                          |   ./data/bot.db   |
                                                          |     (SQLite)      |
                                                          +-------------------+
                                                                    |
                                                       pesan teks terformat
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

`bot.js` (scheduler) dan `node cli.js dashboard` (TUI) bisa jalan barengan tanpa konflik karena SQLite dibuka dalam mode WAL dan log file di-tail read-only oleh dashboard. `bot.js` adalah satu-satunya proses yang menulis ke DB; dashboard hanya membaca. Semua state lokal (SQLite + JSON-line log file) jadi tidak butuh Postgres, Redis, atau message broker. Di Docker Compose, container `bot` ngomong ke `waha` lewat hostname internal `http://waha:3000` (bukan `localhost`), karena tiap service di-resolve di network bridge milik Compose.

## Persyaratan

- **Node.js 20+** (image Docker pin ke `node:20-slim`).
- **Docker** dan plugin `docker compose` v2 untuk stack WAHA + bot.
- **Akun WhatsApp** yang bisa kamu scan QR-nya ke WAHA satu kali.
- **Channel WhatsApp** yang kamu admin, dengan ID format `123456789@newsletter`.
- **RAM** kira-kira 1GB minimum (rekomendasi 2GB+ kalau mau jalan terus 24/7 plus dashboard).
- **Internet** stabil untuk akses x.com dan WAHA.

> ⚠️ **Soal Terms of Service.** Scraping X/Twitter tanpa autentikasi resmi bisa melanggar ToS platform, terutama kalau volume tinggi atau IP datacenter. Pakai dengan kesadaran risiko: turunkan frekuensi (`CHECK_INTERVAL_MINUTES`) untuk akun yang sensitif, dan jangan jalankan ratusan akun dari satu IP. Lihat [Disclaimer](#disclaimer) di bawah.

## Quick Start (Docker Compose)

Cara paling cepat. Semua dependensi (Chromium, WAHA Plus, SQLite native module) sudah dibungkus image Docker.

1. **Clone repo dan masuk ke folder:**

   ```bash
   git clone https://github.com/mocasus/x-scraper-bot.git && cd x-scraper-bot
   ```

2. **Salin `.env.example` ke `.env`:**

   ```bash
   cp .env.example .env
   ```

3. **Boot WAHA dulu (jangan langsung `up -d` semua):**

   ```bash
   docker compose up -d waha && docker compose logs -f waha
   ```

   > 💡 Bot akan crash-loop kalau dia bangun sebelum WAHA siap. Tunggu sampai WAHA log nya tenang (port 3000 listening) sebelum lanjut.

4. **Pair akun WhatsApp ke WAHA:**

   Buka [`http://localhost:3000`](http://localhost:3000) di browser, pilih session `default`, klik **Start**, lalu scan QR yang muncul lewat aplikasi WhatsApp di HP (**Settings → Linked Devices → Link a Device**). Tunggu sampai state session berubah jadi `WORKING` atau `CONNECTED`.

5. **Cari channel ID kamu:**

   ```bash
   curl http://localhost:3000/api/default/channels | jq
   ```

   Cari channel yang kamu admin di output, lalu copy field `id`-nya (formatnya `<digit>@newsletter`).

6. **Edit `.env`** minimal isi dua field ini:

   ```env
   TARGET_ACCOUNTS=elonmusk,whale_alert
   WAHA_CHANNEL_ID=123456789@newsletter
   ```

7. **Nyalain bot:**

   ```bash
   docker compose up -d bot && docker compose logs -f bot
   ```

8. **Cek WhatsApp channel kamu** dalam beberapa menit pertama, harusnya muncul tweet pertama dari akun yang kamu monitor.

> 🖥️ **Tip:** buka terminal kedua dan jalankan `docker compose exec bot node cli.js dashboard` untuk live-monitoring lewat TUI. Detail di [Dashboard TUI](#dashboard-tui).

## Quick Start (Manual / Lokal)

Kalau mau jalan tanpa Docker (misalnya untuk debugging Puppeteer atau ngubah kode):

1. **Install dependensi:**

   ```bash
   npm install
   ```

2. **Salin env dan isi:**

   ```bash
   cp .env.example .env
   # edit .env minimal isi TARGET_ACCOUNTS dan WAHA_CHANNEL_ID
   ```

3. **Jalanin WAHA secara terpisah** (pakai Docker tetap paling gampang):

   ```bash
   docker run -d --name waha -p 3000:3000 devlikeapro/waha-plus
   ```

   Lalu pair QR seperti di Quick Start Docker langkah 4.

4. **Jalankan migration DB** (idempotent, aman dipanggil berulang):

   ```bash
   node cli.js db migrate
   ```

5. **Smoke-test koneksi WAHA:**

   ```bash
   node cli.js health
   ```

   Exit code `0` artinya state-nya `CONNECTED`.

6. **Jalankan scheduler:**

   ```bash
   npm run dev      # nodemon (auto-reload)
   # atau
   npm start        # plain node bot.js
   ```

## Konfigurasi

Semua variabel di bawah dibaca dari `.env` (di-load oleh `dotenv`). Image Docker dan `docker-compose.yml` melewatkan env yang sama nama-nya.

| Variabel | Default | Wajib? | Deskripsi |
| --- | --- | --- | --- |
| `TARGET_ACCOUNTS` | (kosong) | ✅ | Daftar username X yang dipantau, dipisah koma. Awalan `@` opsional dan otomatis di-strip. Contoh: `elonmusk,whale_alert`. |
| `FILTER_KEYWORDS` | (kosong) | ❌ | Daftar keyword (dipisah koma). Kalau diisi, hanya tweet yang mengandung minimal satu keyword (case-insensitive) yang diteruskan. |
| `SKIP_REPLIES` | `true` | ❌ | Drop tweet yang merupakan reply ke user lain. |
| `SKIP_RETWEETS` | `true` | ❌ | Drop retweet dan post yang username di URL-nya beda dari akun yang diminta (anti pinned-repost). |
| `WAHA_URL` | `http://localhost:3000` | ❌ | Base URL WAHA server. Di Docker Compose nilai ini jadi `http://waha:3000`. |
| `WAHA_SESSION` | `default` | ❌ | Nama session WAHA. Harus sama dengan session yang kamu pair di langkah QR scan. |
| `WAHA_CHANNEL_ID` | (kosong) | ✅ | ID channel WhatsApp tujuan, format `123456789@newsletter`. |
| `CHECK_INTERVAL_MINUTES` | `5` | ❌ | Jarak antar siklus scrape, dalam menit. Di-clamp minimum `1`. |
| `MESSAGE_DELAY_MS` | `5000` | ❌ | Jeda antar pengiriman pesan ke WAHA, dalam milidetik. Di-clamp minimum `1000`. |
| `MAX_TWEETS_PER_CHECK` | `5` | ❌ | Maksimal tweet baru yang diposting per akun per siklus. |
| `HEADLESS` | `true` | ❌ | Jalankan Chromium headless. Ubah ke `false` hanya untuk debugging lokal. |

> 🧩 **Catatan tambahan:** `PUPPETEER_EXECUTABLE_PATH` boleh di-set ke path Chromium sistem (image Docker sudah set ke `/usr/bin/chromium`). Kosongkan untuk biarin Puppeteer download Chromium sendiri di pertama kali run.

## Referensi CLI

CLI ada di `cli.js` dan reuse env, logger, plus SQLite handle yang sama dengan scheduler. Tiga cara setara untuk manggil:

```bash
npx x-scraper start       # setelah `npm install` wiring binary
node cli.js start         # invokasi langsung
npm run cli -- start      # via wrapper npm script
```

| Command | Deskripsi | Contoh |
| --- | --- | --- |
| `start [--once]` | Jalankan scheduler scrape → WAHA. Validasi `TARGET_ACCOUNTS` & `WAHA_CHANNEL_ID` dulu. | `node cli.js start --once` |
| `scrape <username>` | Buka satu profil X di Puppeteer dan print tweet ke stdout. Tidak nyentuh DB atau WAHA. | `node cli.js scrape elonmusk --json --limit 3` |
| `send <text>` | Kirim teks satu-kali ke channel WAHA yang dikonfigurasi. | `node cli.js send "Halo channel"` |
| `health` | GET `${WAHA_URL}/api/sessions/${WAHA_SESSION}`. Exit `0` hanya kalau `state=CONNECTED`. | `node cli.js health --json` |
| `stats` | Print jumlah row dan 5 tweet terakhir dari `./data/bot.db`. | `node cli.js stats --json` |
| `logs [-n N] [-f]` | Pretty-print N record terakhir dari `./logs/bot.log`. `-f` follow seperti `tail -f`. | `node cli.js logs -n 100 -f` |
| `accounts list/add/remove` | Edit `TARGET_ACCOUNTS` di `.env` tanpa buka editor. Dedup case-insensitive. | `node cli.js accounts add whale_alert` |
| `db migrate / db reset` | `migrate` idempotent. `reset` butuh `--confirm` untuk drop tabel. | `node cli.js db reset --confirm` |
| `dashboard` (alias `tui`) | Buka TUI dashboard. Butuh TTY. | `node cli.js dashboard --refresh 5` |

### Contoh sesi terminal

```bash
# 1. Cek WAHA udah connected
$ node cli.js health
WAHA state: CONNECTED

# 2. Tambah akun baru ke watchlist
$ node cli.js accounts add naval
added: naval -> TARGET_ACCOUNTS now has 3 entries

# 3. Smoke-test scraping (tidak nulis DB / WAHA)
$ node cli.js scrape naval --limit 2 --dry-run
[dry-run] would post 2 tweets

# 4. Cek isi DB
$ node cli.js stats
total tweets: 142
recent:
  1742... @elonmusk    19m  GPU prices...
  1742... @whale_alert 11m  USDT mint...

# 5. Jalankan scheduler full
$ node cli.js start
[bot] cycle every 5 minutes; targets=[elonmusk, whale_alert, naval]
```

## Dashboard TUI

Subcommand `dashboard` membuka developer TUI di atas SQLite database dan JSON-line log file yang sama dengan yang dibaca scheduler. Mode-nya observer-only: dia tidak menjalankan scraper, tidak post ke WAHA, dan tidak mutasi DB. Boleh dijalankan barengan dengan `node bot.js` karena SQLite dibuka WAL dan log file di-tail read-only.

```bash
npm run dashboard                       # equivalent ke: node cli.js dashboard
node cli.js dashboard --refresh 5       # refresh tiap 5 detik
node cli.js tui                         # alias singkat
```

Dashboard butuh TTY beneran. Kalau `stdout` bukan TTY (di-pipe ke file, dijalankan di CI, atau lewat SSH non-interaktif), prosesnya akan print `dashboard requires a TTY (run from an interactive terminal; not pipeable)` ke stderr dan exit dengan kode `1`. Untuk SSH session, jalankan di dalam `tmux` atau `screen` supaya layout tetap hidup pas reconnect.

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

| Key | Aksi |
| --- | --- |
| `q`, `Ctrl+C` | Quit dan cleanup (interval berhenti, DB ditutup, log tail di-detach). |
| `r` | Refresh semua panel sekarang juga (tidak nunggu interval tick berikutnya). |
| `s` | Spawn `node cli.js scrape <TARGET_ACCOUNT pertama> --json --limit 5` sebagai child process; stdout dan stderr di-stream ke panel logs dengan prefix `[scrape]`. |
| `a` | Buka prompt untuk add/remove target account; reuse `accounts add` / `accounts remove` plus validasi alfabet handle X yang sama. |
| `c` | Clear panel logs di layar dan ring buffer in-memory. File log on-disk (`./logs/bot.log`) tidak diubah. |
| `?`, `h` | Tampilkan modal help dengan daftar keybinding. |
| Arrow, `PgUp`, `PgDn` | Scroll panel logs (didelegasikan ke widget log dari blessed-contrib). |

> 🖥️ **Remote SSH tip:** jalankan dashboard di dalam `tmux` atau `screen` (`tmux new -s bot` lalu `node cli.js dashboard`) supaya layout selamat saat koneksi SSH putus dan TTY bisa di-reattach.

## Testing

```bash
npm test                # 158 test, ~700ms wall time
npm run test:coverage   # suite yang sama plus --experimental-test-coverage
```

Suite ini pakai `node:test` built-in, tanpa Jest atau Mocha. Database pakai `:memory:` SQLite, log file pakai `os.tmpdir()`, dan HTTP client di-mock manual. Tidak ada satupun socket beneran yang dibuka, tidak ada Puppeteer yang launch, dan `./data/bot.db` tidak akan kebentuk pas tes jalan. Aman dijalankan tanpa `.env`:

```bash
node --check bot.js
node --check cli.js
TARGET_ACCOUNTS=elonmusk WAHA_CHANNEL_ID=123@newsletter \
  node -e "console.log(Object.keys(require('./bot.js')).sort().join(','))"
```

## Hosting Gratis 24/7

Bot ini didesain ringan, tapi karena butuh state persistent (SQLite + log) plus headless Chromium, tidak semua "free tier" cocok. Ringkasan:

| Provider | Spec Free Tier | 24/7? | Cocok? | Catatan |
| --- | --- | --- | --- | --- |
| **Oracle Cloud Always Free** | 4 vCPU ARM (Ampere A1) + 24GB RAM, 200GB disk | ✅ | ⭐ paling pas | Forever-free, butuh kartu kredit untuk verifikasi (tidak di-charge). Region tertentu sering "out of capacity"; coba region lain. |
| **GCP Always Free** | 1 vCPU + 1GB RAM (e2-micro), 30GB disk | ✅ | ⚠️ mepet | Bisa, tapi RAM mepet kalau jalanin Chromium + WAHA + bot bareng. Pertimbangkan WAHA di host lain. |
| **Fly.io** | 256MB shared CPU | ✅ | ❌ | Terlalu kecil buat Chromium. Bayar tier juga oke tapi bukan free. |
| **Render** | 512MB, spin-down setelah 15 menit idle | ❌ | ❌ | Bot scheduler tidak boleh spin-down, bakal miss siklus. |
| **Railway** | $5 trial credit ~30 hari | ❌ | ❌ | Bagus untuk eksperimen, habis trial bayar. Lihat sub-bab Deployment. |
| **Replit** | Repl free tier sekarang berbayar untuk always-on | ❌ | ❌ | Auto-sleep memaksa kamu upgrade ke Hacker plan. |

### Setup Oracle Cloud Always Free (rekomendasi)

Pendekatan paling sustainable adalah Oracle Cloud Always Free Tier dengan instance Ampere A1 (ARM). Cukup buat WAHA + bot + dashboard tanpa was-was kena charge.

1. **Daftar di [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).** Butuh kartu kredit untuk verifikasi identity, tapi Always Free resources tidak ditagih.

2. **Buat VM Ampere A1.** Pilih image `Canonical Ubuntu 22.04`, shape `VM.Standard.A1.Flex` dengan 2 OCPU + 12GB RAM (masih dalam batas Always Free). Set SSH public key kamu pas pembuatan.

3. **SSH masuk:**

   ```bash
   ssh -i ~/.ssh/id_ed25519 ubuntu@<public-ip>
   ```

4. **Install Docker + plugin compose:**

   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-plugin
   sudo usermod -aG docker ubuntu
   newgrp docker   # atau logout-login
   ```

5. **Clone repo dan setup:**

   ```bash
   git clone https://github.com/mocasus/x-scraper-bot.git && cd x-scraper-bot
   cp .env.example .env
   ```

6. **Ikuti [Quick Start (Docker Compose)](#quick-start-docker-compose)** dari langkah 3 sampai 8. Untuk scan QR di langkah 4, buka SSH tunnel dari laptop:

   ```bash
   ssh -L 3000:localhost:3000 ubuntu@<public-ip>
   ```

   lalu buka `http://localhost:3000` di browser laptop kamu.

7. **Tutup port 3000 setelah pairing selesai.** Edit Security List di Oracle Console: hapus rule yang expose port 3000 ke `0.0.0.0/0`. Untuk kebutuhan dashboard / re-pair di kemudian hari, tetap pakai SSH tunnel.

> ⚠️ **Login wall warning.** IP datacenter (Oracle, GCP, AWS) lebih sering kena login wall X dibanding IP residential. Kalau scrape gagal terus, naikin `CHECK_INTERVAL_MINUTES` ke 10-15 menit dan kurangi jumlah `TARGET_ACCOUNTS`.

> ⚠️ **WAHA tanpa autentikasi.** WAHA Plus default tidak ada API key, jadi siapapun yang bisa akses port 3000 bisa send pesan dari akun WhatsApp kamu. **Wajib** tutup port 3000 dari public internet setelah QR scan beres, dan akses lewat SSH tunnel saja.

## Deployment

### Docker Compose (local / VPS)

`docker-compose.yml` yang ada di repo udah bawa WAHA + bot bareng, dengan bind mount `./data` dan `./logs` jadi state-nya survive container restart. Lihat [Quick Start (Docker Compose)](#quick-start-docker-compose).

### Railway

`railway.json` udah set Dockerfile builder dan `node bot.js` sebagai start command. Set semua env var di Railway dashboard. Catatan penting:

- WAHA **harus** di-deploy terpisah (service Railway sendiri, atau VPS lain). Bot ngomong ke WAHA lewat private URL Railway atau public URL eksternal.
- Free $5 trial credit kira-kira habis dalam ~1 bulan kalau bot jalan terus 24/7. Setelah itu bayar pay-as-you-go.

### VPS biasa

Hetzner CX11 (€4.5/bulan, 2GB RAM) atau setara dari Contabo / DigitalOcean / Linode. Steps-nya identik dengan setup Oracle Cloud di atas (mulai dari install Docker), kecuali kamu bayar bulanan. Cocok kalau tidak mau ribet sama Always Free tier verification atau region availability.

## Troubleshooting

- **Chromium gagal launch (`Failed to launch the browser process`).** Host kekurangan shared library. Install paket apt yang ada di `Dockerfile` (`libnss3`, `libxcomposite1`, `libgbm1`, dll), atau pakai Docker yang udah include semuanya.
- **WAHA tidak `CONNECTED`.** Buka `http://localhost:3000`, rescan QR pake HP yang punya channel. Session di-persist di volume `waha_data`; hapus volume itu untuk force re-pair dari nol.
- **Pesan duplikat masuk channel.** Biasanya berarti DB `./data/bot.db` ke-reset (misalnya volume di-recreate). Jangan jalankan `db reset` di production. Kalau memang harus, terima saja batch pertama post-reset bakal banyak.
- **Post sporadis / WAHA drop pesan.** Naikin `CHECK_INTERVAL_MINUTES` dan/atau `MESSAGE_DELAY_MS`. WhatsApp aggressive rate-limit channel broadcast; di atas ~1 pesan per 5 detik biasanya kena throttle.
- **X login wall (`Sign in to X`).** Bot best-effort dismiss popup via selector `[data-testid="app-bar-close"]`, tapi sebagian akun + IP range tetap di-force login. Solusi: turunkan frekuensi, kurangi target, atau rotasi egress IP. Tidak ada in-bot login flow.
- **`SQLITE_BUSY` atau `database is locked`.** Hanya satu proses yang boleh nulis ke `./data/bot.db`. Cek apakah ada instance bot lama yang masih jalan; matikan dulu sebelum start ulang. Dashboard read-only aman jalan barengan.
- **Dashboard exit 1 dengan pesan `requires a TTY`.** Kamu jalanin lewat pipe atau di environment non-interactive (cron, CI). Solusi: jalankan langsung di terminal interaktif, atau bungkus dalam `tmux`/`screen` untuk SSH session.
- **`docker compose` vs `docker-compose`.** Repo ini pakai sintaks v2 (`docker compose`, dengan spasi). Kalau host kamu masih pakai `docker-compose` (v1, dengan dash), command-nya sama tapi binary-nya beda. Update ke `docker-compose-plugin` (v2) kalau memungkinkan.

## Roadmap

Ide-ide yang ada di radar tapi belum di-build. PR welcome untuk yang prioritasnya jelas.

### Pengiriman & Format

- Multi-channel: post ke beberapa WhatsApp channel sekaligus dari satu bot.
- Media forwarding: download gambar/video tweet lalu kirim sebagai attachment, bukan link.
- Thread reconstruction: rangkai tweet thread jadi satu pesan panjang dengan formatting.
- Auto-translate: integrasi DeepL / OpenAI buat translate tweet sebelum diposting.
- AI summarize: untuk thread atau tweet panjang, bikin TL;DR via LLM.

### Filtering & Quality

- Engagement filter: skip tweet di bawah threshold likes/retweets/views.
- Keyword exclude: blacklist keyword (kebalikan `FILTER_KEYWORDS`).
- Hashtag dedup: kalau dua akun post hashtag campaign yang sama, post sekali aja.
- Sentiment filter: skip tweet dengan sentiment negatif/spam pakai model lokal.

### Source & Output Tambahan

- Twitter Lists support: monitor Twitter List ID, bukan cuma akun individu.
- Multi-source: scrape Telegram channel, YouTube uploads, RSS feed sebagai source tambahan.
- Output tambahan: forward ke Telegram bot dan Discord webhook, bukan cuma WhatsApp.

### Operations & DevX

- Web dashboard: alternatif TUI dengan UI browser-based (mungkin Astro + HTMX).
- Health endpoint: HTTP `/healthz` untuk uptime monitoring eksternal.
- Discord heartbeat: ping ke Discord webhook tiap N siklus sebagai dead-man switch.
- S3 backup: auto-upload SQLite db dan log ke S3-compatible storage.
- Catch-up mode: kalau bot mati lama, bisa pilih skip backlog atau post bertahap.
- Per-account rate limit: interval beda-beda per akun (misal news account 2 menit, akun santai 30 menit).
- Smart scheduler: adaptive interval berdasarkan posting frequency historis tiap akun.
- Quiet hours: window waktu tertentu (misal jam 23.00-06.00) bot tidak post ke channel.

## Berkontribusi

PR sangat diterima. Saat buka PR, sertakan: versi Node, OS yang dipakai, isi `.env` (sanitized, tanpa channel ID atau credential), dan log relevan dari `./logs/bot.log`. Issue duluan untuk fitur besar lebih dihargai daripada PR surprise yang ngubah arsitektur, supaya kita bisa diskusi pendekatan dulu.

Untuk bug report, paling efektif kalau kamu bisa kasih reproduksi minimal: target accounts, env relevan, dan trace error. Screenshot dashboard juga membantu kalau bug-nya UI-related.

Convention coding di repo ini: **CommonJS** (`require/module.exports`, bukan ESM), **no TypeScript** (vanilla JS dengan JSDoc kalau perlu type hint), dan testing **node:test built-in** (jangan tambahin Jest/Vitest/Mocha). Tujuannya keep deps minimal dan startup time cepat.

Pre-PR checklist:

```bash
npm test                                      # 158/158 harus pass
node --check bot.js cli.js dashboard/*.js     # syntax check, harus exit 0
docker build -t x-scraper-bot:test .          # image masih build
```

## Lisensi

MIT. Lihat file [LICENSE](LICENSE) di root repo. Singkatnya: kamu bebas pakai, modifikasi, dan distribusi ulang, asal copyright notice tetap ada dan tidak ada warranty dari penulis.

## Disclaimer

> ⚠️ **Project ini disediakan apa-adanya, untuk keperluan personal dan edukasi.**
>
> Scraping X/Twitter tanpa autentikasi resmi mungkin melanggar [Terms of Service](https://x.com/en/tos) platform. Kamu sepenuhnya bertanggung jawab atas akses yang kamu lakukan, termasuk kepatuhan terhadap rate limit, robot policy, dan hukum yurisdiksi kamu.
>
> Reposting konten pihak ketiga ke WhatsApp channel kamu tunduk pada hukum copyright dan rules WhatsApp itu sendiri. Pastikan kamu punya hak untuk redistribusi konten yang kamu post, atau setidaknya pakai dengan attribution yang layak.
>
> Penulis dan kontributor project ini **tidak bertanggung jawab** atas suspensi akun X, suspensi akun WhatsApp, takedown legal, kerugian data, atau konsekuensi lain dari penggunaan bot ini. Pakai dengan kesadaran risiko.

---

<div align="center">
<sub>Built with ☕ in Indonesia · v1.0.0</sub>
</div>
