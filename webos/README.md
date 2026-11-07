# Bullix for webOS (LG TV)

Web client for **LG webOS** TVs: same JSON API and HLS resolution flow as the Android TV app (`https://z2.idlixku.com/` by default). Built as a packaged **Hosted Web App** (HTML/CSS/JS + `appinfo.json`).

## Features

- Home (hero, continue watching, trending, popular movies & series)
- Movies & Series lists, search, detail pages, episode grid
- HLS playback via **hls.js** with CDN token preservation on segment URLs (mirrors Android `QueryPreservingDataSource`)
- Configurable backend URL and local watch progress (`localStorage`)

## Requirements

- **Node.js** 18+ (for the build step)
- **webOS TV CLI** for **install/launch on device** (`ares-install`, `ares-launch`, `ares-setup-device`). Packaging uses **`@webos-tools/cli`** from this repo’s `devDependencies` — run `npm install` in `webos/` so `npm run package` can find `ares-package`.  
  Optional global install: `npm install -g @webos-tools/cli` ([CLI install](https://webostv.developer.lge.com/develop/sdk/webos-tv-cli-installation))

## Icons

If you want custom tiles, add **`webos/icon.png`** (80×80) and **`webos/icon-large.png`** (130×130). Otherwise `npm run build` generates solid red placeholders so `ares-package` can succeed.

## Build

```bash
cd webos
npm install
npm run build
```

Output: `webos/dist/` (`index.html`, `styles.css`, `app.js`, `appinfo.json`).

## Package IPK

```bash
cd webos
npm run package
```

This runs `npx ares-package dist ./service/com.idlix.tv.webos.proxy -o .` and writes **`com.idlix.tv.webos_*_all.ipk`**. The IPK includes a **Node JS service** that sends the same `Origin` / `Referer` / `User-Agent` headers as the Android OkHttp client (the TV browser cannot set `Origin`). **`ares-package` comes from `node_modules` after `npm install`**.

## Install on TV (developer mode)

TV and PC must be on the **same Wi‑Fi/LAN**.

### 1. On the TV

1. Install **Developer Mode** from LG Content Store and sign in with your [LG Developer](https://webostv.developer.lge.com/) account.
2. Turn **Dev Mode Status** **ON** (TV reboots).
3. Open Developer Mode again → turn **Key Server** **ON**.
4. Note the **IP address** (e.g. `192.168.1.42`) and the **6‑character Passphrase** on screen.

### 2. Register the TV in CLI (`ares-setup-device` asks for port)

From the `webos/` folder (or use global `ares-*` if installed with `-g`):

```bash
cd webos
npx ares-setup-device
```

Choose **add**, then use:

| Prompt | Typical value |
|--------|----------------|
| Device name | e.g. `mytv` |
| IP address | Shown in Developer Mode (not `127.0.0.1`) |
| **Port** | **`9922`** (default for LG **TV**; emulator uses another port) |
| ssh user | **`prisoner`** |
| Password | **leave empty** (Key Server + novacom key instead) |
| Set default? | Yes (optional) |
| Save? | Yes |

One-line add (optional):

```bash
npx ares-setup-device -a mytv -i "host=192.168.1.42" -i "port=9922" -i "username=prisoner"
```

### 3. SSH key (passphrase from TV)

With **Key Server ON** on the TV:

```bash
npx ares-novacom --device mytv --getkey
```

Enter the **Passphrase** exactly as shown on the TV (case sensitive).

Verify:

```bash
npx ares-device --device mytv --system-info
```

### 4. Install and launch the app

```bash
npm run package
npx ares-install --device mytv com.idlix.tv.webos_1.0.17_all.ipk
npx ares-launch --device mytv com.idlix.tv.webos
```

Replace `mytv` and the `.ipk` filename if yours differs (`ls *.ipk`).

### Blank / black screen after install?

1. Rebuild and reinstall (startup JS is now split + transpiled for older webOS Chromium):

   ```bash
   cd webos
   npm run package
   npx ares-install --device mytv com.idlix.tv.webos_1.0.17_all.ipk
   npx ares-launch --device mytv com.idlix.tv.webos
   ```

2. If you still see only black, open the inspector (TV on, USB debugging path may vary):

   ```bash
   npx ares-inspect --device mytv --app com.idlix.tv.webos
   ```

   Or stream app logs: `npx ares-log --device mytv --follow`

3. A red error line on screen means JavaScript failed — note the message from the inspector console.

## Local preview + playback proxy (Chromium)

Claim (`POST /api/watch/session/claim`) is rejected unless `Origin` is `https://z2.idlixku.com`. Browsers cannot set that header. `npm run serve` starts **Playwright Chromium**, opens the API site (solves Cloudflare), then proxies `/p?u=…` as **same-origin** requests — same idea as Android OkHttp.

```bash
cd webos
npm install
npm run serve
```

First run downloads Chromium (slow once). Open **http://127.0.0.1:5173**.

**Without Chromium** (`npm run serve:node`): uses **`curl_cffi` Chrome TLS** if `.venv-impersonate` exists (`/health` has `"impersonate": true`). Otherwise Node/curl (often CF 403).

```bash
python3 -m venv .venv-impersonate
.venv-impersonate/bin/pip install -r scripts/requirements-impersonate.txt
npm run serve:node
```

Use `npm run serve` only if CF still serves a JS challenge.

### Play on the LG TV (TV-only)

1. `npm run package` → install the IPK on the TV (`ares-install` / Developer Mode).
2. Empty proxy URL: watch APIs use **Luna `proxyFetch`** (TV curl/Node).
3. To use the PC proxy: `npm run serve:node`, same Wi‑Fi, **Pengaturan → URL proxy PC** = `http://<PC-LAN-IP>:5173` (printed in the terminal — **not** `127.0.0.1`). The app skips Luna and sends claim/HLS to that host.

## CSP

`index.html` allows `connect-src *` so the app can reach the streaming API and CDN. Tighten this if you fork the project for production.
