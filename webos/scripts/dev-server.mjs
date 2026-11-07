/**
 * Local preview + playback proxy on /p?u=
 * curl_cffi Chrome TLS when .venv-impersonate exists; else Node https.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const SITE = "https://z2.idlixku.com/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
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

let publicOrigin = `http://127.0.0.1:${PORT}`;

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

function hostOf(url) {
  try {
    return new NodeURL(url).hostname;
  } catch {
    return "";
  }
}

function shouldImpersonate(targetUrl) {
  const host = hostOf(targetUrl);
  if (!/(^|\.)idlixku\.com$/i.test(host)) return false;
  if (/\.(ts|m4s|mp4|m4a|key)(\?|$)/i.test(targetUrl)) return false;
  return true;
}

function headerFromReq(reqHeaders, name) {
  const k = name.toLowerCase();
  return reqHeaders[k] ?? reqHeaders[name] ?? reqHeaders[name.toLowerCase()];
}

function outboundNodeHeaders(reqHeaders, targetUrl) {
  const headers = { ...ANDROID_HEADERS };
  if (!shouldImpersonate(targetUrl || "")) {
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

async function nodeProxyFetch(targetUrl, method, reqHeaders, bodyBuf) {
  if (impersonateProc && shouldImpersonate(targetUrl)) {
    try {
      return await impersonateFetch(targetUrl, method, reqHeaders, bodyBuf);
    } catch (err) {
      console.warn("impersonate failed, falling back:", err.message || err);
    }
  }
  return nodeHttpFetch(targetUrl, method, reqHeaders, bodyBuf);
}

async function upstreamFetch(targetUrl, method, reqHeaders, bodyBuf) {
  return nodeProxyFetch(targetUrl, method, reqHeaders, bodyBuf);
}

async function warmupNodeProxy() {
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
        nodeProxy: true,
        impersonate: !!impersonateProc,
        chromium: false,
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

const impersonateOn = await startImpersonateWorker();
if (impersonateOn) {
  console.log("TLS impersonate chrome131 (curl_cffi).");
} else {
  console.log("Node https proxy (no impersonate). Claim may fail Cloudflare.");
  console.log(
    "For Chrome TLS: python3 -m venv .venv-impersonate && .venv-impersonate/bin/pip install -r scripts/requirements-impersonate.txt"
  );
}
await warmupNodeProxy();

server.listen(PORT, HOST, () => {
  const ips = lanIPs();
  publicOrigin = `http://127.0.0.1:${PORT}`;
  console.log(`Bullix preview: http://127.0.0.1:${PORT}`);
  ips.forEach((ip) => {
    console.log(`TV playback proxy: http://${ip}:${PORT}  (Pengaturan → URL proxy PC)`);
  });
});
