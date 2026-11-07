/**
 * Local dev: static app + playback proxy on /p?u=
 * Default: Playwright Chromium (Cloudflare + same-origin idlixku).
 * IDLIX_NO_CHROMIUM=1 or --no-chromium: Node/curl only (Android-like headers, no browser).
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, URL as NodeURL } from "node:url";

const execAsync = promisify(exec);

const NO_CHROMIUM =
  process.env.IDLIX_NO_CHROMIUM === "1" ||
  process.env.NODE_PROXY === "1" ||
  process.argv.includes("--no-chromium");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const SITE = "https://z2.idlixku.com/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROFILE = path.join(os.tmpdir(), "idlix-pw-profile");
const COOKIE_JAR = path.join(os.tmpdir(), "bullix-dev-proxy-cookies.txt");

const ANDROID_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "User-Agent": UA,
  Referer: "https://z2.idlixku.com/",
  Origin: "https://z2.idlixku.com",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

let curlAvailable = null;
let impersonateProc = null;
let impersonateReady = null;
let impersonateSeq = 0;
const impersonatePending = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".map": "application/json",
};

let browserContext = null;
let sitePage = null;
let publicOrigin = `http://127.0.0.1:${PORT}`;
let warmupTitle = "";
let warmupChallenged = false;

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((n) => {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    });
  });
  return out;
}

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    ...extra,
  };
}

function rewritePlaylist(body, playlistUrl, proxyOrigin) {
  let tokenQuery = "";
  try {
    const u = new NodeURL(playlistUrl);
    tokenQuery = u.search && u.search.length > 1 ? u.search.slice(1) : "";
  } catch {
    tokenQuery = "";
  }
  const withToken = (abs) => {
    if (!tokenQuery || /(?:\?|&)t=/.test(abs)) return abs;
    return `${abs}${abs.indexOf("?") >= 0 ? "&" : "?"}${tokenQuery}`;
  };
  const wrap = (abs) => `${proxyOrigin}/p?u=${encodeURIComponent(withToken(abs))}`;
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.charAt(0) === "#") {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try {
            return `URI="${wrap(new NodeURL(uri, playlistUrl).toString())}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        return wrap(new NodeURL(trimmed, playlistUrl).toString());
      } catch {
        return line;
      }
    })
    .join("\n");
}

function looksLikePlaylist(ct, body, targetUrl) {
  if (/mpegurl|m3u8|x-mpeg/i.test(ct || "")) return true;
  if (/\.m3u8(\?|$)/i.test(targetUrl || "")) return true;
  const head = String(body || "")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .slice(0, 16);
  return head.indexOf("#EXTM3U") === 0;
}

function isChallengeTitle(title) {
  return /just a moment|attention required|cloudflare/i.test(String(title || ""));
}

function launchOpts(headed) {
  return {
    headless: !headed,
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    },
    args: ["--disable-blink-features=AutomationControlled"],
  };
}

async function openPersistent(headed) {
  const { chromium } = await import("playwright");
  const opts = launchOpts(headed);
  try {
    return await chromium.launchPersistentContext(PROFILE, { ...opts, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(PROFILE, opts);
  }
}

async function waitOutChallenge(page, ms) {
  try {
    await page.waitForFunction(
      () => !/just a moment|attention required/i.test(document.title || ""),
      { timeout: ms }
    );
  } catch {
    /* still challenged */
  }
}

async function bootChromium() {
  console.log("Launching Chromium (Cloudflare + same-origin claim)…");
  fs.mkdirSync(PROFILE, { recursive: true });
  let headed = process.env.IDLIX_HEADED === "1";
  browserContext = await openPersistent(headed);
  sitePage = browserContext.pages()[0] || (await browserContext.newPage());
  try {
    await sitePage.goto(SITE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sitePage.waitForTimeout(4000);
    await waitOutChallenge(sitePage, 90000);
    warmupTitle = await sitePage.title();
    warmupChallenged = isChallengeTitle(warmupTitle);
    if (warmupChallenged && !headed && process.env.IDLIX_HEADED !== "0") {
      console.warn("Cloudflare still challenging headless Chromium — retrying headed…");
      await browserContext.close();
      headed = true;
      browserContext = await openPersistent(true);
      sitePage = browserContext.pages()[0] || (await browserContext.newPage());
      await sitePage.goto(SITE, { waitUntil: "domcontentloaded", timeout: 90000 });
      await waitOutChallenge(sitePage, 120000);
      warmupTitle = await sitePage.title();
      warmupChallenged = isChallengeTitle(warmupTitle);
    }
    console.log(
      "Chromium on z2.idlixku.com — title:",
      warmupTitle,
      warmupChallenged ? "(CHALLENGED)" : "(ok)"
    );
  } catch (e) {
    console.warn("Warmup navigation:", e.message || e);
  }
}

function hostOf(url) {
  try {
    return new NodeURL(url).hostname;
  } catch {
    return "";
  }
}

function shouldUsePageFetch(targetUrl) {
  const host = hostOf(targetUrl);
  if (!/(^|\.)idlixku\.com$/i.test(host)) return false;
  if (/\.(ts|m4s|mp4|m4a|key)(\?|$)/i.test(targetUrl)) return false;
  return true;
}

async function ensureSitePage() {
  if (!browserContext) throw new Error("Chromium not ready");
  if (!sitePage || sitePage.isClosed()) {
    sitePage = await browserContext.newPage();
  }
  const href = sitePage.url() || "";
  if (!/idlixku\.com/i.test(href) || isChallengeTitle(await sitePage.title().catch(() => ""))) {
    await sitePage.goto(SITE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitOutChallenge(sitePage, 60000);
  }
}

async function pageFetch(targetUrl, method, reqHeaders, bodyBuf) {
  await ensureSitePage();
  const headers = {
    Accept: reqHeaders.accept || reqHeaders.Accept || "application/json, text/plain, */*",
  };
  const ct = reqHeaders["content-type"] || reqHeaders["Content-Type"];
  if (ct) headers["Content-Type"] = ct;
  const cookie = reqHeaders["x-idlix-cookie"] || reqHeaders["X-Idlix-Cookie"] || "";
  const bodyB64 = bodyBuf && bodyBuf.length ? bodyBuf.toString("base64") : "";
  const result = await sitePage.evaluate(
    async ({ url, method, headers, bodyB64, cookie }) => {
      if (cookie) {
        String(cookie)
          .split(";")
          .forEach((part) => {
            const bit = part.trim();
            if (bit) document.cookie = `${bit}; path=/`;
          });
      }
      const init = { method, headers, credentials: "include" };
      if (bodyB64) {
        const binary = atob(bodyB64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        init.body = bytes;
      }
      const res = await fetch(url, init);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const outHeaders = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      return { status: res.status, headers: outHeaders, bodyB64: btoa(binary) };
    },
    { url: targetUrl, method: method || "GET", headers, bodyB64, cookie }
  );
  const body = Buffer.from(result.bodyB64, "base64");
  return {
    status: () => result.status,
    headers: () => result.headers || {},
    body: async () => body,
  };
}

async function apiFetch(targetUrl, method, reqHeaders, bodyBuf) {
  if (!browserContext) throw new Error("Chromium not ready");
  const headers = {
    Accept: "application/json, text/plain, */*",
    Origin: "https://z2.idlixku.com",
    Referer: "https://z2.idlixku.com/",
    "User-Agent": UA,
  };
  const ct = reqHeaders["content-type"];
  if (ct) headers["Content-Type"] = ct;
  const cookie = reqHeaders["x-idlix-cookie"];
  if (cookie) headers.Cookie = cookie;

  const opts = {
    method: method || "GET",
    headers,
    timeout: 45000,
    failOnStatusCode: false,
    maxRedirects: 10,
  };
  if (bodyBuf && bodyBuf.length && method !== "GET" && method !== "HEAD") {
    opts.data = bodyBuf;
  }
  return browserContext.request.fetch(targetUrl, opts);
}

async function chromiumFetch(targetUrl, method, reqHeaders, bodyBuf) {
  if (shouldUsePageFetch(targetUrl)) {
    try {
      return await pageFetch(targetUrl, method, reqHeaders, bodyBuf);
    } catch (err) {
      console.warn("page fetch failed, falling back to APIRequest:", err.message || err);
    }
  }
  return apiFetch(targetUrl, method, reqHeaders, bodyBuf);
}

function headerFromReq(reqHeaders, name) {
  const k = name.toLowerCase();
  return reqHeaders[k] ?? reqHeaders[name] ?? reqHeaders[name.toLowerCase()];
}

function outboundNodeHeaders(reqHeaders, targetUrl) {
  const headers = { ...ANDROID_HEADERS };
  if (!shouldUsePageFetch(targetUrl || "")) {
    delete headers["Sec-Fetch-Site"];
    delete headers["Sec-Fetch-Mode"];
    delete headers["Sec-Fetch-Dest"];
    headers["Sec-Fetch-Site"] = "cross-site";
  }
  const ct = headerFromReq(reqHeaders, "content-type");
  if (ct) headers["Content-Type"] = ct;
  const cookie = headerFromReq(reqHeaders, "x-idlix-cookie");
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function impersonatePython() {
  const venv = path.join(__dirname, "..", ".venv-impersonate", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return process.env.IDLIX_IMPERSONATE_PYTHON || "";
}

function startImpersonateWorker() {
  if (impersonateReady) return impersonateReady;
  const py = impersonatePython();
  const script = path.join(__dirname, "impersonate-worker.py");
  if (!py || !fs.existsSync(script)) {
    impersonateReady = Promise.resolve(false);
    return impersonateReady;
  }
  impersonateReady = new Promise((resolve) => {
    const child = spawn(py, ["-u", script], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = impersonatePending.get(msg.id);
        if (pending) {
          impersonatePending.delete(msg.id);
          pending(msg);
        }
      }
    });
    child.stderr.on("data", (c) => {
      const t = c.toString("utf8").trim();
      if (t) console.log("impersonate:", t);
      if (!settled && /warmup ok/i.test(t)) done(true);
    });
    child.on("error", (err) => {
      console.warn("impersonate worker error:", err.message || err);
      impersonateProc = null;
      done(false);
    });
    child.on("exit", () => {
      impersonateProc = null;
      impersonateReady = null;
      impersonatePending.forEach((cb) => cb({ ok: false, error: "worker exit" }));
      impersonatePending.clear();
      done(false);
    });
    impersonateProc = child;
    setTimeout(() => done(!!impersonateProc), 4000);
  });
  return impersonateReady;
}

function impersonateFetch(targetUrl, method, reqHeaders, bodyBuf) {
  return new Promise((resolve, reject) => {
    if (!impersonateProc || !impersonateProc.stdin.writable) {
      reject(new Error("impersonate worker down"));
      return;
    }
    const id = ++impersonateSeq;
    const timer = setTimeout(() => {
      impersonatePending.delete(id);
      reject(new Error("impersonate timeout"));
    }, 50000);
    impersonatePending.set(id, (msg) => {
      clearTimeout(timer);
      if (!msg.ok) {
        reject(new Error(msg.error || "impersonate failed"));
        return;
      }
      const body = Buffer.from(msg.bodyB64 || "", "base64");
      resolve({
        status: () => Number(msg.status) || 502,
        headers: () => msg.headers || {},
        body: async () => body,
      });
    });
    const headers = outboundNodeHeaders(reqHeaders, targetUrl);
    impersonateProc.stdin.write(
      `${JSON.stringify({
        id,
        url: targetUrl,
        method: method || "GET",
        headers,
        bodyB64: bodyBuf && bodyBuf.length ? bodyBuf.toString("base64") : "",
      })}\n`
    );
  });
}

async function detectCurl() {
  if (curlAvailable !== null) return curlAvailable;
  try {
    await execAsync("curl --version");
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }
  return curlAvailable;
}

function nodeHttpFetch(targetUrl, method, reqHeaders, bodyBuf) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new NodeURL(targetUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const headers = outboundNodeHeaders(reqHeaders, targetUrl);
    const m = method === "HEAD" ? "GET" : method || "GET";
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: m,
        headers,
        timeout: 45000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: () => res.statusCode || 502,
            headers: () => res.headers || {},
            body: async () => body,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("upstream timeout"));
    });
    req.on("error", reject);
    if (bodyBuf?.length && m !== "GET" && m !== "HEAD") req.write(bodyBuf);
    req.end();
  });
}

function curlFetch(targetUrl, method, reqHeaders, bodyBuf) {
  return new Promise((resolve, reject) => {
    const headers = outboundNodeHeaders(reqHeaders, targetUrl);
    const m = method || "GET";
    const args = [
      "-sS",
      "-L",
      "--compressed",
      "--max-time",
      "45",
      "-w",
      "\n__CURL_STATUS__:%{http_code}",
      "-X",
      m,
      "-A",
      UA,
      "-b",
      COOKIE_JAR,
      "-c",
      COOKIE_JAR,
    ];
    Object.entries(headers).forEach(([k, v]) => {
      args.push("-H", `${k}: ${v}`);
    });
    args.push(targetUrl);
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      let buf = Buffer.concat(out);
      let text = buf.toString("utf8");
      let status = code === 0 ? 200 : 502;
      const mark = "\n__CURL_STATUS__:";
      const idx = text.lastIndexOf(mark);
      if (idx >= 0) {
        status = parseInt(text.slice(idx + mark.length), 10) || status;
        buf = Buffer.from(text.slice(0, idx), "utf8");
      }
      resolve({
        status: () => status,
        headers: () => ({}),
        body: async () => buf,
      });
    });
    if (bodyBuf?.length) {
      child.stdin.write(bodyBuf);
    }
    child.stdin.end();
  });
}

async function nodeProxyFetch(targetUrl, method, reqHeaders, bodyBuf) {
  // Same split as Chromium: impersonate only idlixku JSON/API.
  // HLS/CDN must stay on Node (parallel binary). Serial Python .ts kills TV playback.
  if (impersonateProc && shouldUsePageFetch(targetUrl)) {
    try {
      return await impersonateFetch(targetUrl, method, reqHeaders, bodyBuf);
    } catch (err) {
      console.warn("impersonate failed, falling back:", err.message || err);
    }
  }
  return nodeHttpFetch(targetUrl, method, reqHeaders, bodyBuf);
}

async function upstreamFetch(targetUrl, method, reqHeaders, bodyBuf) {
  if (NO_CHROMIUM) return nodeProxyFetch(targetUrl, method, reqHeaders, bodyBuf);
  return chromiumFetch(targetUrl, method, reqHeaders, bodyBuf);
}

async function warmupNodeProxy() {
  try {
    fs.mkdirSync(path.dirname(COOKIE_JAR), { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    await upstreamFetch(SITE, "GET", {}, Buffer.alloc(0));
    console.log("Node proxy warmup:", SITE);
  } catch (e) {
    console.warn("Node proxy warmup failed:", e.message || e);
  }
}

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function originForClient(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function handleProxy(req, res, targetUrl) {
  let parsed;
  try {
    parsed = new NodeURL(targetUrl);
  } catch {
    res.writeHead(400, cors({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Bad target URL" }));
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.writeHead(400, cors({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Only http/https" }));
    return;
  }

  try {
    const method = req.method === "HEAD" ? "GET" : req.method || "GET";
    const bodyBuf = await collectBody(req);
    const pwRes = await upstreamFetch(targetUrl, method, req.headers, bodyBuf);
    const status = pwRes.status();
    console.log(`${method} ${status} ${targetUrl.slice(0, 120)}`);
    const ct = String(pwRes.headers()["content-type"] || "");
    const buf = Buffer.from(await pwRes.body());
    const peekText =
      /m3u8|mpegurl|json|text|xml|javascript|vtt/i.test(ct) ||
      /\.m3u8(\?|$)/i.test(targetUrl) ||
      /\.vtt(\?|$)/i.test(targetUrl);

    if (!peekText) {
      res.writeHead(status, cors({ "Content-Type": ct || "application/octet-stream" }));
      res.end(buf);
      return;
    }

    let body = buf.toString("utf8");
    const out = cors({ "Content-Type": ct || "text/plain; charset=utf-8" });
    if (looksLikePlaylist(ct, body, targetUrl)) {
      body = rewritePlaylist(body, targetUrl, originForClient(req));
      out["Content-Type"] = "application/vnd.apple.mpegurl";
      res.writeHead(status, out);
      res.end(body);
    } else if (/\.vtt(\?|$)/i.test(targetUrl)) {
      out["Content-Type"] = "text/vtt; charset=utf-8";
      res.writeHead(status, out);
      res.end(buf);
    } else {
      res.writeHead(status, out);
      res.end(buf);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, cors({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  }
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new NodeURL(req.url, "http://127.0.0.1").pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(dist, pathname.replace(/^\/+/, "")));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    res.end();
    return;
  }
  const u = new NodeURL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/health") {
    res.writeHead(200, cors({ "Content-Type": "application/json" }));
    res.end(
      JSON.stringify({
        ok: true,
        chromium: !!browserContext,
        nodeProxy: NO_CHROMIUM,
        impersonate: !!impersonateProc,
        challenged: warmupChallenged,
        title: warmupTitle,
        base: publicOrigin,
      })
    );
    return;
  }
  if (u.pathname === "/p" || u.pathname === "/p/") {
    const target = u.searchParams.get("u") || "";
    if (!target) {
      res.writeHead(400, cors({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: "missing u" }));
      return;
    }
    handleProxy(req, res, target);
    return;
  }
  serveStatic(req, res);
});

if (NO_CHROMIUM) {
  const impersonateOn = await startImpersonateWorker();
  if (impersonateOn) {
    console.log("TLS impersonate chrome131 (curl_cffi) — no Playwright.");
  } else {
    console.log(
      "IDLIX_NO_CHROMIUM=1 — Node/curl proxy (no Playwright). Claim may fail if Cloudflare blocks."
    );
    console.log(
      "For Chrome TLS: python3 -m venv .venv-impersonate && .venv-impersonate/bin/pip install -r scripts/requirements-impersonate.txt"
    );
  }
  await warmupNodeProxy();
} else {
  try {
    await bootChromium();
  } catch (e) {
    console.error("Chromium failed. Run: npx playwright install chromium");
    console.error("Or: npm run serve:node (no Chromium, may not pass Cloudflare)");
    console.error(e);
    process.exit(1);
  }
}

server.listen(PORT, HOST, () => {
  const ips = lanIPs();
  publicOrigin = `http://127.0.0.1:${PORT}`;
  if (NO_CHROMIUM) {
    console.log(`Bullix preview (node proxy): http://127.0.0.1:${PORT}`);
  } else {
    console.log(`Bullix preview: http://127.0.0.1:${PORT}`);
  }
  ips.forEach((ip) => {
    console.log(`TV playback proxy: http://${ip}:${PORT}  (Pengaturan → URL proxy pemutaran)`);
  });
});
