/**
 * Bullix TV — webOS client (HTML5).
 * Mirrors Android app: same public API + stream resolution flow.
 */

// ——— Preferences & watch history (localStorage) ———

const PREFS_KEY = "bullix_webos_prefs_v1";
const HISTORY_KEY = "bullix_webos_history_v1";
const WATCHLIST_KEY = "bullix_webos_watchlist_v1";

const DEFAULT_BACKEND = "https://z2.idlixku.com/";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function getBaseUrl() {
  const p = loadPrefs();
  const url = (p.backendUrl || DEFAULT_BACKEND).trim();
  return url.endsWith("/") ? url : `${url}/`;
}

function setBaseUrl(url) {
  const trimmed = url.trim() || DEFAULT_BACKEND;
  const formatted = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const prefs = loadPrefs();
  prefs.backendUrl = formatted;
  savePrefs(prefs);
}

function normalizeProxyBase(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) {
    u = `http://${u}`;
  }
  return u.replace(/\/+$/, "");
}

function setPlaybackProxyUrl(url) {
  const prefs = loadPrefs();
  prefs.playbackProxyUrl = normalizeProxyBase(url);
  savePrefs(prefs);
  resetProxyState();
}

function getPlaybackProxyUrl() {
  return normalizeProxyBase(loadPrefs().playbackProxyUrl || "");
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 60)));
}

function getSavedPosition(contentId) {
  const key = `${contentId}_pos`;
  const keyDur = `${contentId}_dur`;
  const pos = Number(localStorage.getItem(key) || 0);
  const dur = Number(localStorage.getItem(keyDur) || 0);
  if (dur > 0 && pos > dur * 0.95) return 0;
  return pos;
}

function updateProgress(contentId, positionMs, durationMs) {
  localStorage.setItem(`${contentId}_pos`, String(positionMs));
  localStorage.setItem(`${contentId}_dur`, String(durationMs));
  localStorage.setItem(`${contentId}_time`, String(Date.now()));
  const list = loadHistory();
  const idx = list.findIndex((h) => h.contentId === contentId);
  if (idx >= 0) {
    const old = list[idx];
    list[idx] = {
      ...old,
      positionMs,
      durationMs,
      lastWatchedTime: Date.now(),
    };
    saveHistory(list);
  }
}

function recordStartPlayback(entry) {
  const list = loadHistory().filter((h) => h.contentId !== entry.contentId);
  const savedPos = getSavedPosition(entry.contentId);
  const dur = Number(localStorage.getItem(`${entry.contentId}_dur`) || 0);
  list.unshift({
    ...entry,
    positionMs: entry.positionMs ?? savedPos,
    durationMs: entry.durationMs ?? dur,
    lastWatchedTime: Date.now(),
  });
  saveHistory(list);
}

function removeHistoryItem(contentId) {
  saveHistory(loadHistory().filter((h) => h.contentId !== contentId));
  localStorage.removeItem(`${contentId}_pos`);
  localStorage.removeItem(`${contentId}_dur`);
  localStorage.removeItem(`${contentId}_time`);
}

function clearAllHistory() {
  const ids = loadHistory().map((h) => h.contentId);
  ids.forEach((id) => {
    localStorage.removeItem(`${id}_pos`);
    localStorage.removeItem(`${id}_dur`);
    localStorage.removeItem(`${id}_time`);
  });
  localStorage.removeItem(HISTORY_KEY);
}

function getUnfinished() {
  return loadHistory().filter((h) => {
    const pos = h.positionMs || 0;
    const dur = h.durationMs || 0;
    return pos >= 10_000 && (dur <= 0 || pos < dur * 0.95);
  });
}

function watchlistKey(entry) {
  const id = entry.contentId || entry.slug || "";
  return `${entry.contentType || "movie"}:${id}`;
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWatchlist(items) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(items.slice(0, 120)));
}

function isInWatchlist(contentType, contentId, slug) {
  const key = watchlistKey({ contentType, contentId, slug });
  return loadWatchlist().some((w) => watchlistKey(w) === key);
}

function addToWatchlist(entry) {
  const key = watchlistKey(entry);
  const next = loadWatchlist().filter((w) => watchlistKey(w) !== key);
  next.unshift({
    contentId: entry.contentId,
    contentType: entry.contentType,
    slug: entry.slug,
    title: entry.title,
    posterUrl: entry.posterUrl || "",
    backdropUrl: entry.backdropUrl || "",
    savedAt: Date.now(),
  });
  saveWatchlist(next);
  return true;
}

function removeFromWatchlist(contentType, contentId, slug) {
  const key = watchlistKey({ contentType, contentId, slug });
  saveWatchlist(loadWatchlist().filter((w) => watchlistKey(w) !== key));
}

function toggleWatchlist(entry) {
  if (isInWatchlist(entry.contentType, entry.contentId, entry.slug)) {
    removeFromWatchlist(entry.contentType, entry.contentId, entry.slug);
    return false;
  }
  addToWatchlist(entry);
  return true;
}

function clearWatchlist() {
  localStorage.removeItem(WATCHLIST_KEY);
}

function watchlistToCatalog(item) {
  return {
    id: item.contentId,
    slug: item.slug,
    title: item.title,
    contentType: item.contentType,
    posterPath: item.posterUrl,
    backdropPath: item.backdropUrl,
  };
}

function updateWatchlistButton(btn, contentType, contentId, slug) {
  if (!btn) return;
  const saved = isInWatchlist(contentType, contentId, slug);
  btn.textContent = saved ? "Hapus dari daftar" : "Simpan ke daftar";
  btn.classList.toggle("btn--watchlist-saved", saved);
  btn.setAttribute("aria-pressed", saved ? "true" : "false");
}

// ——— HTTP (webOS Node proxy = Android OkHttp Origin/Referer) ———

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PROXY_SERVICE = "luna://com.idlix.tv.webos.proxy";
const PROXY_HEALTH_TTL_MS = 12 * 1000;
const PROXY_FETCH_RETRIES = 2;

let proxyBase = "";
let proxyReady = null;
let proxyHealthAt = 0;
let lunaProxyReady = false;

function resetProxyState() {
  proxyBase = "";
  proxyReady = null;
  proxyHealthAt = 0;
  lunaProxyReady = false;
}

function isLoopbackProxy(base) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/i.test(String(base || ""));
}

function isLikelyProxyConnError(err) {
  const msg = String((err && err.message) || err || "");
  return (
    /failed to fetch|networkerror|load failed|connection refused|err_connection_refused/i.test(
      msg
    ) || (err && err.name === "TypeError")
  );
}

function isWebOSTv() {
  if (typeof window === "undefined") return false;
  if (window.PalmSystem || (window.webOS && window.webOS.service)) return true;
  return /Web0S|webOS/i.test(navigator.userAgent || "");
}

function isLocalBrowser() {
  if (typeof location === "undefined") return false;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function htmlForbiddenMessage(status, text) {
  const body = String(text || "");
  if (/Cross-site request blocked/i.test(body)) {
    return isWebOSTv()
      ? "Claim ditolak (Origin). Isi Pengaturan → URL proxy PC (npm run serve:node, IP LAN)."
      : "Claim ditolak (Origin). Jalankan npm run serve:node.";
  }
  if (/Just a moment|cf-mitigated|challenges\.cloudflare|cdn-cgi/i.test(body)) {
    return isWebOSTv()
      ? "Cloudflare. Pastikan serve:node + .venv-impersonate, URL PC = IP LAN (bukan 127.0.0.1)."
      : "Cloudflare. npm run serve:node dengan .venv-impersonate (bukan Chromium).";
  }
  if (Number(status) === 403 || /<!DOCTYPE|<html/i.test(body)) {
    return "403 HTML (Cloudflare). TV: Pengaturan → URL proxy PC dari npm run serve:node.";
  }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function lunaRequest(uri, method, parameters) {
  return new Promise((resolve, reject) => {
    const svc = window.webOS && window.webOS.service;
    if (!svc || typeof svc.request !== "function") {
      reject(new Error("webOS service bridge tidak tersedia"));
      return;
    }
    svc.request(uri, {
      method: method,
      parameters: parameters || {},
      onSuccess: (res) => resolve(res),
      onFailure: (err) =>
        reject(new Error((err && (err.errorText || err.message)) || "luna gagal")),
    });
  });
}

function proxyHealthOk(j) {
  if (!j || j.ok === false) return false;
  if (j.chromium === true || j.nodeProxy === true || j.onDevice === true || j.impersonate === true) {
    return true;
  }
  return !!(j.ok && j.base);
}

function probeHealth(base) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
  return fetch(`${base}/health`, ctrl ? { signal: ctrl.signal } : undefined)
    .then(async (res) => {
      if (!res.ok) throw new Error("health not ok");
      const j = await res.json().catch(() => ({}));
      if (!proxyHealthOk(j)) {
        throw new Error("proxy not ready");
      }
      return base;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function startTvProxyService() {
  const info = await lunaRequest(PROXY_SERVICE, "startProxy", {});
  if (info && info.returnValue === false) {
    throw new Error((info.errorText && String(info.errorText)) || "startProxy gagal");
  }
  lunaProxyReady = true;
  const base = info && info.base ? String(info.base) : "";
  if (base) {
    try {
      await probeHealth(base);
      proxyBase = base;
      proxyHealthAt = Date.now();
    } catch (_) {
      proxyBase = "";
    }
  }
  return proxyBase;
}

function lunaResponse(info) {
  const status = Number(info && info.status) || 0;
  const text = String((info && info.body) || "");
  const ct = String((info && info.contentType) || "");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return /content-type/i.test(String(name || "")) ? ct : null;
      },
    },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

async function lunaProxyFetch(absoluteUrl, init) {
  const headers = (init && init.headers) || {};
  const info = await lunaRequest(PROXY_SERVICE, "proxyFetch", {
    url: absoluteUrl,
    method: (init && init.method) || "GET",
    body: init && init.body != null ? String(init.body) : "",
    contentType: headers["Content-Type"] || headers["content-type"] || "",
    cookie: headers["X-Idlix-Cookie"] || "",
  });
  if (info && info.returnValue === false) {
    throw new Error((info.errorText && String(info.errorText)) || "luna proxyFetch gagal");
  }
  return lunaResponse(info);
}

async function refreshProxyIfStale() {
  if (!proxyBase) return false;
  const ttl = isWebOSTv() ? PROXY_HEALTH_TTL_MS : 30 * 1000;
  const due = !proxyHealthAt || Date.now() - proxyHealthAt > ttl;
  if (!due) return true;
  try {
    await probeHealth(proxyBase);
    proxyHealthAt = Date.now();
    return true;
  } catch (_) {
    resetProxyState();
    return false;
  }
}

async function ensureProxy(opts = {}) {
  if (opts.force) resetProxyState();

  const pref = getPlaybackProxyUrl();
  if (proxyBase && !opts.force) {
    if (pref && proxyBase !== pref) {
      resetProxyState();
    } else {
      const ok = await refreshProxyIfStale();
      if (ok) return proxyBase;
    }
  }
  if (lunaProxyReady && isWebOSTv() && !pref && !opts.force) {
    return proxyBase || "";
  }

  if (proxyReady && !opts.force) return proxyReady;

  proxyReady = (async () => {
    if (isLocalBrowser()) {
      const local = `${location.protocol}//${location.host}`;
      await probeHealth(local);
      proxyBase = local;
      proxyHealthAt = Date.now();
      return proxyBase;
    }

    if (isWebOSTv()) {
      if (pref) {
        if (isLoopbackProxy(pref)) {
          throw new Error(
            "URL proxy PC tidak boleh 127.0.0.1 (itu TV, bukan Mac). Isi http://IP-LAN:5173 dari npm run serve:node."
          );
        }
        try {
          await probeHealth(pref);
          lunaProxyReady = false;
          proxyBase = pref;
          proxyHealthAt = Date.now();
          return proxyBase;
        } catch (e) {
          throw new Error(
            `Proxy PC tidak terjangkau (${pref}). npm run serve:node + .venv-impersonate? Satu Wi‑Fi? Mac firewall? ${e && e.message ? e.message : e}`
          );
        }
      }
      let builtinErr = null;
      try {
        await startTvProxyService();
        return proxyBase || "";
      } catch (e) {
        builtinErr = e instanceof Error ? e : new Error(String(e));
        lunaProxyReady = false;
      }
      const hint =
        "Pasang ulang IPK terbaru (npm run package) jika layanan proxy ikut ter-bundle.";
      throw new Error(
        `Proxy bawaan TV gagal${builtinErr?.message ? `: ${builtinErr.message}` : ""}. ${hint} Opsional: Pengaturan → URL proxy PC (npm run serve:node).`
      );
    }

    if (pref) {
      await probeHealth(pref);
      proxyBase = pref;
      proxyHealthAt = Date.now();
      return proxyBase;
    }
    return "";
  })().catch((err) => {
    proxyReady = null;
    if (isLocalBrowser()) {
      throw new Error(
        `Jalankan npm run serve:node. ${err && err.message ? err.message : err}`
      );
    }
    if (isWebOSTv()) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return "";
  });
  return proxyReady;
}

function proxiedUrl(absoluteUrl) {
  if (!proxyBase || !absoluteUrl) return absoluteUrl;
  if (String(absoluteUrl).indexOf(proxyBase) === 0) return absoluteUrl;
  return `${proxyBase}/p?u=${encodeURIComponent(absoluteUrl)}`;
}

function unwrapProxied(url) {
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.origin : "http://127.0.0.1");
    if (u.pathname === "/p" || u.pathname === "/p/") {
      return u.searchParams.get("u") || url;
    }
  } catch {
    /* ignore */
  }
  return url;
}

function requireProxied(absoluteUrl, what) {
  const out = proxiedUrl(absoluteUrl);
  if (!proxyBase || !absoluteUrl || out === absoluteUrl) {
    throw new Error(
      `Origin proxy tidak aktif untuk ${what || "request"}. Jangan fetch langsung ke API (akan 403).`
    );
  }
  return out;
}

function apiHeaders(extra = {}) {
  return {
    Accept: "application/json, text/plain, */*",
    "User-Agent": UA,
    Referer: "https://z2.idlixku.com/",
    ...extra,
  };
}

/** Catalog/search/detail: browser fetch only (this worked before the Origin proxy). */
function catalogHeaders(extra = {}) {
  return {
    Accept: "application/json, text/plain, */*",
    ...extra,
  };
}

function isWatchApiPath(path) {
  return /api\/watch|api\/playback|session\/claim/.test(String(path || ""));
}

async function fetchProxiedResponse(absoluteUrl, init, useProxy) {
  if (isWebOSTv() && useProxy) {
    const pref = getPlaybackProxyUrl();
    if (pref) {
      await ensureProxy();
    } else {
      try {
        await ensureProxy();
      } catch (_) {
        /* Luna-only path */
      }
      try {
        if (!lunaProxyReady) {
          await startTvProxyService();
        }
        return await lunaProxyFetch(absoluteUrl, init);
      } catch (lunaErr) {
        if (!proxyBase) throw lunaErr;
      }
    }
  }
  let lastErr;
  const retries = useProxy && (isWebOSTv() || isLocalBrowser()) ? PROXY_FETCH_RETRIES : 1;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      resetProxyState();
    }
    let base = "";
    try {
      base = await ensureProxy({ force: attempt > 0 });
    } catch (err) {
      if (isWebOSTv() && useProxy) throw err;
    }
    const viaProxy = !!base && (isLocalBrowser() || useProxy);
    const target = viaProxy ? proxiedUrl(absoluteUrl) : absoluteUrl;
    try {
      return await fetch(target, init);
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= retries || !viaProxy || !isLikelyProxyConnError(err)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error("fetch gagal");
}

async function fetchJson(path, options = {}) {
  const url = new URL(path.replace(/^\//, ""), getBaseUrl()).toString();
  const watchPath = isWatchApiPath(path) || options.useProxy;
  const headers = catalogHeaders(options.headers || {});
  if (options.idlixCookie) {
    headers["X-Idlix-Cookie"] = options.idlixCookie;
  }
  const init = {
    method: options.method || "GET",
    headers,
    body: options.body,
    credentials: "omit",
  };
  const res = await fetchProxiedResponse(url, init, watchPath || options.useProxy);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${htmlForbiddenMessage(res.status, text)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.indexOf("application/json") !== -1) {
    return res.json();
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDidFromGateToken(gateToken) {
  try {
    const rawP0 = gateToken.split(".")[0];
    const bin = base64UrlDecode(rawP0);
    const p0 = new TextDecoder().decode(bin);
    const m = /"owner":"d:([^"]+)"/.exec(p0);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "====".slice(0, 4 - pad);
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extractTokenQuery(masterUrl) {
  try {
    const u = new URL(masterUrl, "https://dummy.invalid/");
    const t = u.searchParams.get("t");
    if (t) return `t=${encodeURIComponent(t)}`;
    const qs = u.search;
    if (qs && qs.length > 1) return qs.slice(1);
  } catch {
    /* ignore */
  }
  return "";
}

function appendTokenToUrl(url, tokenQuery) {
  if (!tokenQuery || /(?:\?|&)t=/.test(url)) return url;
  const sep = url.indexOf("?") !== -1 ? "&" : "?";
  return `${url}${sep}${tokenQuery}`;
}

function resolveLoaderUrl(url, context) {
  let s = String(url || "");
  if (!s) return s;
  if (s.startsWith("/p?") && proxyBase) {
    try {
      s = new URL(s, proxyBase).href;
    } catch {
      /* ignore */
    }
  }
  if (!/^https?:\/\//i.test(s) && context) {
    const base =
      context.frag?.baseurl ||
      context.frag?.url ||
      context.levelDetails?.url ||
      context.deliveryDirectives?.baseUrl;
    if (base) {
      try {
        s = new URL(s, base).href;
      } catch {
        /* ignore */
      }
    }
  }
  return s;
}

/** Same as Android: full query string from master playlist URL */
function tokenQueryFromMaster(masterUrl) {
  try {
    const u = new URL(masterUrl);
    return u.search && u.search.length > 1 ? u.search.slice(1) : "";
  } catch {
    return extractTokenQuery(masterUrl);
  }
}

function buildHlsConfig(Hls, tokenQuery) {
  const config = {
    enableWorker: !isWebOSTv(),
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 6,
    startFragPrefetch: true,
  };
  const BaseLoader = Hls.DefaultConfig.loader;
  if (typeof BaseLoader !== "function") return config;
  class IdlixLoader extends BaseLoader {
    load(context, cfg, callbacks) {
      if (context && context.url) {
        let url = resolveLoaderUrl(context.url, context);
        if (proxyBase) {
          const inner = unwrapProxied(url);
          const withTok = tokenQuery ? appendTokenToUrl(inner, tokenQuery) : inner;
          context.url = proxiedUrl(withTok);
        } else if (tokenQuery) {
          context.url = appendTokenToUrl(url, tokenQuery);
        } else {
          context.url = url;
        }
      }
      super.load(context, cfg, callbacks);
    }
  }
  config.loader = IdlixLoader;
  return config;
}

function waitForVideoEvent(video, eventName, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      video.removeEventListener(eventName, onOk);
      video.removeEventListener("error", onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    video.addEventListener(eventName, onOk, { once: true });
    video.addEventListener("error", onErr, { once: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function tryPlayVideo(video) {
  try {
    await video.play();
    if (!video.paused) return true;
  } catch (_) {
    /* autoplay may require mute */
  }
  const wasMuted = video.muted;
  video.muted = true;
  try {
    await video.play();
    video.muted = wasMuted;
    return !video.paused;
  } catch (_) {
    video.muted = wasMuted;
    return false;
  }
}

async function tryNativeHls(video, masterUrl, timeoutMs = 2500) {
  video.removeAttribute("crossorigin");
  video.src = masterUrl;
  video.load();
  if (video.readyState >= 1) {
    try {
      await video.play();
    } catch (_) {
      /* autoplay blocked: still ready for the user to press Putar */
    }
    return video.readyState >= 1;
  }
  const played = await waitForVideoEvent(video, "playing", timeoutMs);
  if (played || video.readyState >= 1) return true;
  await waitForVideoEvent(video, "loadedmetadata", timeoutMs);
  if (video.readyState < 1) return false;
  try {
    await video.play();
  } catch (_) {
    /* user can press Putar */
  }
  return true;
}

// ——— Repository ———

const IdlixApi = {
  getMovies(params = {}) {
    const q = new URLSearchParams();
    q.set("page", String(params.page ?? 1));
    q.set("limit", String(params.limit ?? 20));
    if (params.sort) q.set("sort", params.sort);
    if (params.genre) q.set("genre", params.genre);
    return fetchJson(`api/movies?${q}`);
  },
  getSeries(params = {}) {
    const q = new URLSearchParams();
    q.set("page", String(params.page ?? 1));
    q.set("limit", String(params.limit ?? 20));
    if (params.sort) q.set("sort", params.sort);
    if (params.genre) q.set("genre", params.genre);
    return fetchJson(`api/series?${q}`);
  },
  getMovieDetail(slug) {
    return fetchJson(`api/movies/${encodeURIComponent(slug)}`);
  },
  getSeriesDetail(slug) {
    return fetchJson(`api/series/${encodeURIComponent(slug)}`);
  },
  getEpisodeDetail(slug, season, episode) {
    return fetchJson(
      `api/series/${encodeURIComponent(slug)}/season/${season}/episode/${episode}`
    );
  },
  getGenres() {
    return fetchJson("api/genres");
  },
  search(query) {
    return fetchJson(`api/search?q=${encodeURIComponent(query)}`);
  },
  getMoviePlayInfo(id) {
    return fetchJson(`api/watch/play-info/movie/${encodeURIComponent(id)}`);
  },
  getEpisodePlayInfo(id) {
    return fetchJson(`api/watch/play-info/episode/${encodeURIComponent(id)}`);
  },
  claimSession(gateToken, did) {
    return fetchJson("api/watch/session/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gateToken }),
      idlixCookie: did ? `did=${did}` : undefined,
    });
  },
  resolvePlayback(contentType, contentId, contentTitle, gateToken) {
    const q = new URLSearchParams({
      contentType,
      contentId,
    });
    if (contentTitle) q.set("contentTitle", contentTitle);
    if (gateToken) q.set("gateToken", gateToken);
    return fetchJson(`api/playback/resolve?${q}`);
  },
  async redeemPlay(url, claim) {
    const init = {
      method: "POST",
      credentials: "omit",
      headers: catalogHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ claim, mode: "browser" }),
    };
    const res = await fetchProxiedResponse(url, init, true);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Redeem failed ${res.status}: ${htmlForbiddenMessage(res.status, text)}`);
    }
    return res.json();
  },
};

const playbackCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function resolveStream(contentType, contentId, contentTitle, onCountdown) {
  const cacheKey = `${contentType}:${contentId}`;
  const cached = playbackCache.get(cacheKey);
  const cacheOk =
    cached &&
    Date.now() - cached.ts < CACHE_TTL_MS &&
    (onCountdown == null ||
      (Array.isArray(cached.playback.subtitles) && cached.playback.subtitles.length > 0));
  if (cacheOk) {
    onCountdown?.(0);
    return cached.playback;
  }
  if (onCountdown != null) {
    const stale = playbackCache.get(cacheKey);
    if (
      stale?.playback?.hlsMasterUrl &&
      (!stale.playback.subtitles || !stale.playback.subtitles.length)
    ) {
      playbackCache.delete(cacheKey);
    }
  }

  let targetType = contentType;
  let targetId = contentId;

  if (contentType === "tv_series") {
    const series = await IdlixApi.getSeriesDetail(contentId).catch(() => null);
    const firstEp =
      series?.defaultSeason?.episodes?.[0] ??
      (await (async () => {
        if (!series?.slug) return null;
        for (const s of series.seasons || []) {
          const det = await IdlixApi.getEpisodeDetail(series.slug, s.seasonNumber, 1).catch(
            () => null
          );
          const ep = det?.episode ?? det?.season?.episodes?.[0] ?? null;
          if (ep?.id) return ep;
        }
        return null;
      })());
    if (!firstEp?.id) {
      throw new Error("Tidak ada episode yang tersedia untuk serial ini.");
    }
    targetType = "episode";
    targetId = firstEp.id;
  }

  if (onCountdown == null) {
    try {
      const resolved = await IdlixApi.resolvePlayback(targetType, targetId, contentTitle);
      if (resolved?.hlsMasterUrl) {
        if (resolved.subtitles?.length) {
          playbackCache.set(cacheKey, { playback: resolved, ts: Date.now() });
        }
        return resolved;
      }
    } catch {
      /* fall through */
    }
  }

  const playInfo =
    targetType === "episode"
      ? await IdlixApi.getEpisodePlayInfo(targetId)
      : await IdlixApi.getMoviePlayInfo(targetId);

  if (!playInfo?.gateToken) {
    throw new Error("Gagal memperoleh token pemutaran");
  }

  const diffMs =
    playInfo.serverNow > 0 && playInfo.unlockAt > playInfo.serverNow
      ? playInfo.unlockAt - playInfo.serverNow
      : 15000;

  const did = extractDidFromGateToken(playInfo.gateToken);

  let secondsLeft = Math.floor(diffMs / 1000);
  while (secondsLeft > 1) {
    onCountdown?.(secondsLeft);
    await sleep(1000);
    secondsLeft--;
  }
  if (secondsLeft > 0) onCountdown?.(1);

  onCountdown?.(0);

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const resolved = await IdlixApi.resolvePlayback(
        targetType,
        targetId,
        contentTitle,
        playInfo.gateToken
      );
      if (
        resolved &&
        resolved.hlsMasterUrl &&
        Array.isArray(resolved.subtitles) &&
        resolved.subtitles.length > 0
      ) {
        playbackCache.set(cacheKey, { playback: resolved, ts: Date.now() });
        return resolved;
      }
    } catch (e) {
      if (/404/.test(String((e && e.message) || ""))) break;
    }
    await sleep(500);
  }

  let validClaim = null;
  let lastClaimHint = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const res = await IdlixApi.claimSession(playInfo.gateToken, did);
      if (res && res.kind === "pentos" && res.claim) {
        validClaim = res;
        break;
      }
      if (res && res.kind) lastClaimHint = `kind=${res.kind}`;
    } catch (e) {
      lastClaimHint = (e && e.message) || "claim error";
    }
    await sleep(600);
  }

  if (!validClaim || !validClaim.claim) {
    throw new Error(
      `Gagal mengklaim sesi pemutaran. Silakan coba lagi.${lastClaimHint ? ` (${lastClaimHint})` : ""}`
    );
  }

  const redeemUrl = validClaim.redeemUrl?.trim()
    ? validClaim.redeemUrl
    : "https://e2e.majorplay.net/api/play";

  const redeemRes = await IdlixApi.redeemPlay(redeemUrl, validClaim.claim).catch(() => null);
  if (!redeemRes?.url) {
    throw new Error("Gagal mengambil master playlist HLS.");
  }

  const playback = {
    title: validClaim.title || contentTitle || "",
    hlsMasterUrl: redeemRes.url,
    subtitles: redeemRes.subtitles || [],
    durationSec: validClaim.durationSec || 0,
    videoId: validClaim.videoId || "",
  };

  playbackCache.set(cacheKey, { playback, ts: Date.now() });
  return playback;
}

function prewarmStream(contentType, contentId, contentTitle) {
  const cacheKey = `${contentType}:${contentId}`;
  const c = playbackCache.get(cacheKey);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return;
  resolveStream(contentType, contentId, contentTitle, null).catch(() => {});
}

// ——— Image URLs ———

function posterUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/w342${path}`;
}

function backdropUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/w1280${path}`;
}

function stillUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/w500${path}`;
}

function historyThumb(h) {
  const b = h.backdropUrl;
  const p = h.posterUrl;
  if (b && String(b).startsWith("http")) return b;
  if (p && String(p).startsWith("http")) return p;
  if (b) return backdropUrl(b);
  if (p) return posterUrl(p);
  return "";
}

// ——— Router ———

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "") || "home";
  const [path, query = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  return { segments, params };
}

function navigate(path) {
  window.location.hash = path.startsWith("#") ? path : `#/${path}`;
}

// ——— UI root ———

const appEl = document.getElementById("app");

let playerCleanup = null;
let controlsHideTimer = null;
const CHROME_IDLE_MS = 3000;

function focusFirst(container) {
  const el = container?.querySelector?.(
    "button, a, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
  );
  el?.focus?.();
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function renderShell(mainContent, active) {
  const items = [
    { id: "home", label: "Beranda", icon: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" },
    { id: "search", label: "Cari", icon: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79L20 21.5 21.5 20l-6-6zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" },
    { id: "continue", label: "Lanjutkan", icon: "M13 3a9 9 0 1 0 8.94 10h-2.02A7 7 0 1 1 13 5v4l5-5-5-5v4z" },
    {
      id: "watchlist",
      label: "Daftar",
      icon: "M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z",
    },
    { id: "movies", label: "Film", icon: "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" },
    { id: "series", label: "Serial", icon: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" },
    { id: "settings", label: "Pengaturan", icon: "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.49.49 0 0 0 13.9 2h-3.8a.49.49 0 0 0-.48.41l-.36 2.54c-.6.22-1.14.54-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.85 14.5a.49.49 0 0 0-.12.61l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.4 1.03.72 1.63.94l.36 2.54c.05.24.25.41.48.41h3.8c.24 0 .44-.17.48-.41l.36-2.54c.6-.22 1.14-.54 1.63-.94l2.39.96c.24.1.51 0 .64-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" },
  ];
  const nav = items
    .map(
      (i) => `
    <button class="nav-item${active === i.id ? " is-active" : ""}" data-nav="${i.id}" type="button">
      <svg class="nav-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${i.icon}"/></svg>
      <span class="nav-item__label">${i.label}</span>
    </button>`
    )
    .join("");
  appEl.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand">Bullix</div>
        <nav class="sidebar__nav">${nav}</nav>
      </aside>
      <main class="main" id="main-pane">${mainContent}</main>
    </div>`;

  appEl.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.nav));
  });
}

async function renderHome() {
  renderShell(`<div class="loading"><span class="spinner"></span>Memuat…</div>`, "home");
  const pane = document.getElementById("main-pane");
  try {
    const [trendingRes, popularRes, seriesRes] = await Promise.all([
      IdlixApi.getMovies({ page: 1, limit: 20, sort: "popularity" }),
      IdlixApi.getMovies({ page: 1, limit: 20 }),
      IdlixApi.getSeries({ page: 1, limit: 20, sort: "popularity" }),
    ]);
    const trending = trendingRes.data || [];
    const popular = popularRes.data || [];
    const popularSeries = seriesRes.data || [];
    const hero = trending[0] || popular[0] || null;
    const cw = getUnfinished();
    const wl = loadWatchlist();

    const heroBlock = hero
      ? `
      <section class="hero">
        <div class="hero__bg" style="background-image:url('${backdropUrl(hero.backdropPath)}')"></div>
        <div class="hero__gradient"></div>
        <div class="hero__content">
          <div class="hero__badge">${hero.contentType === "tv_series" ? "SERIAL" : "FILM"}</div>
          <h2 class="hero__title">${escapeHtml(hero.title)}</h2>
          <div class="hero__meta">
            <span class="hero__match">${escapeHtml(hero.quality || "HD")}</span>
            <span>${hero.contentType === "tv_series" ? "Serial TV" : "Film"}</span>
          </div>
          <p class="hero__overview">${escapeHtml(String(hero.overview || "").slice(0, 220))}</p>
          <div class="btn-row">
            <button class="btn btn--play" type="button" data-action="play-hero">
              <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              Putar
            </button>
            <button class="btn btn--info" type="button" data-action="detail-hero">Selengkapnya</button>
            <button class="btn btn--info" type="button" data-action="watchlist-hero" id="hero-watchlist">Simpan ke daftar</button>
          </div>
        </div>
      </section>`
      : "";

    const wlRow =
      wl.length > 0
        ? `
      <section class="row">
        <h3 class="row__title">Daftar tonton</h3>
        <div class="poster-strip">
          ${wl.slice(0, 16).map((item) => cardHtml(watchlistToCatalog(item))).join("")}
        </div>
      </section>`
        : "";

    const cwRow =
      cw.length > 0
        ? `
      <section class="row">
        <h3 class="row__title">Lanjutkan menonton</h3>
        <div class="poster-strip" id="cw-strip">
          ${cw.map((item) => cardHtml(item, { continue: true })).join("")}
        </div>
      </section>`
        : "";

    pane.innerHTML = `
      ${heroBlock}
      ${wlRow}
      ${cwRow}
      <section class="row">
        <h3 class="row__title">Sedang tren</h3>
        <div class="poster-strip">${trending.map((m) => cardHtml(m)).join("")}</div>
      </section>
      <section class="row">
        <h3 class="row__title">Film populer</h3>
        <div class="poster-strip">${popular.map((m) => cardHtml(m)).join("")}</div>
      </section>
      <section class="row">
        <h3 class="row__title">Serial populer</h3>
        <div class="poster-strip">${popularSeries.map((s) => cardHtml(s)).join("")}</div>
      </section>
    `;

    if (hero) {
      pane.querySelector('[data-action="play-hero"]')?.addEventListener("click", () => {
        if (hero.contentType === "tv_series") {
          navigate(`detail/${hero.contentType}/${encodeURIComponent(hero.slug)}`);
        } else {
          openPlayer({
            contentType: "movie",
            contentId: hero.id,
            title: hero.title,
            poster: posterUrl(hero.posterPath),
            backdrop: backdropUrl(hero.backdropPath),
            slug: hero.slug,
          });
        }
      });
      pane.querySelector('[data-action="detail-hero"]')?.addEventListener("click", () => {
        navigate(`detail/${hero.contentType}/${encodeURIComponent(hero.slug)}`);
      });
      const heroWlBtn = pane.querySelector("#hero-watchlist");
      updateWatchlistButton(heroWlBtn, hero.contentType, hero.id, hero.slug);
      heroWlBtn?.addEventListener("click", () => {
        toggleWatchlist({
          contentId: hero.id,
          contentType: hero.contentType || "movie",
          slug: hero.slug,
          title: hero.title,
          posterUrl: posterUrl(hero.posterPath),
          backdropUrl: backdropUrl(hero.backdropPath),
        });
        updateWatchlistButton(heroWlBtn, hero.contentType, hero.id, hero.slug);
      });
    }

    bindCards(pane);
    focusFirst(pane);
  } catch (e) {
    pane.innerHTML = `<div class="error">Gagal memuat beranda: ${escapeHtml(e.message)}</div>`;
  }
}

function bindCards(root) {
  (root || document).querySelectorAll("[data-card]").forEach((node) => {
    const go = () => handleCardClick(JSON.parse(node.dataset.card));
    node.addEventListener("click", go);
    node.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.keyCode === 13) {
        ev.preventDefault();
        go();
      }
    });
  });
}

function cardHtml(item, opts = {}) {
  const isCw = opts.continue;
  const isWl = opts.watchlist;
  const poster = isCw ? historyThumb(item) : posterUrl(item.posterPath);
  const title = isCw ? item.title : item.title;
  const removeKey =
    isWl && opts.removeKey
      ? `<button class="card__remove" type="button" data-remove-watchlist="${escapeHtml(
          opts.removeKey
        )}" aria-label="Hapus dari daftar">×</button>`
      : "";
  const payload = isCw
    ? {
        contentType: item.contentType,
        slug: item.slug,
        id: item.contentId,
        title: item.title,
        poster: item.posterUrl,
        backdrop: item.backdropUrl,
        season: item.seasonNumber,
        episode: item.episodeNumber,
      }
    : {
        contentType: item.contentType || "movie",
        slug: item.slug,
        id: item.id,
        title: item.title,
        poster: posterUrl(item.posterPath),
        backdrop: backdropUrl(item.backdropPath),
      };
  const progress =
    isCw && item.durationMs > 0
      ? `<div class="cw-card__progress"><span style="width:${Math.min(
          100,
          (item.positionMs / item.durationMs) * 100
        )}%"></span></div>`
      : "";
  return `
    <div class="card${isCw ? " card--wide cw-card" : ""}${isWl ? " card--watchlist" : ""}" tabindex="0" data-card='${JSON.stringify(payload).replace(/'/g, "&#39;")}'>
      <img class="card__img" alt="" src="${poster}" loading="lazy" />
      <div class="card__shade"></div>
      <div class="card__title">${escapeHtml(title)}</div>
      ${progress}
      ${removeKey}
    </div>`;
}

function bindWatchlistRemoves(root) {
  (root || document).querySelectorAll("[data-remove-watchlist]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const parts = String(btn.dataset.removeWatchlist || "").split(":");
      if (parts.length < 2) return;
      const contentType = parts[0];
      const id = parts.slice(1).join(":");
      const entry = loadWatchlist().find((w) => watchlistKey(w) === `${contentType}:${id}`);
      if (entry) removeFromWatchlist(entry.contentType, entry.contentId, entry.slug);
      const card = btn.closest(".card");
      card?.remove();
      const pane = document.getElementById("main-pane");
      if (pane && !pane.querySelector("[data-remove-watchlist]")) {
        const empty = pane.querySelector(".watchlist-empty");
        if (empty) empty.hidden = false;
      }
    });
  });
}

function handleCardClick(data) {
  if (data.contentType === "tv_series") {
    navigate(`detail/tv_series/${encodeURIComponent(data.slug)}`);
  } else if (data.contentType === "movie") {
    navigate(`detail/movie/${encodeURIComponent(data.slug)}`);
  } else if (data.contentType === "episode") {
    openPlayer({
      contentType: "episode",
      contentId: data.id,
      title: data.title,
      poster: data.poster,
      backdrop: data.backdrop,
      slug: data.slug,
      season: data.season,
      episode: data.episode,
    });
  } else {
    openPlayer({
      contentType: data.contentType || "movie",
      contentId: data.id,
      title: data.title,
      poster: data.poster,
      backdrop: data.backdrop,
      slug: data.slug,
    });
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderList(kind) {
  const title = kind === "movies" ? "Film" : "Serial";
  renderShell(`<div class="loading">Memuat ${title}…</div>`, kind);
  const pane = document.getElementById("main-pane");
  try {
    const res =
      kind === "movies"
        ? await IdlixApi.getMovies({ page: 1, limit: 40 })
        : await IdlixApi.getSeries({ page: 1, limit: 40 });
    const items = res.data || [];
    pane.innerHTML = `
      <h1 class="page-title">${title}</h1>
      <div class="poster-grid">${items.map((m) => cardHtml(m)).join("")}</div>
    `;
    bindCards(pane);
    focusFirst(pane);
  } catch (e) {
    pane.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
  }
}

async function renderContinue() {
  renderShell("", "continue");
  const pane = document.getElementById("main-pane");
  const items = getUnfinished();
  if (items.length === 0) {
    pane.innerHTML = `<h1 class="page-title">Lanjutkan menonton</h1><p class="muted">Belum ada riwayat.</p>`;
    focusFirst(appEl);
    return;
  }
  pane.innerHTML = `
    <h1 class="page-title">Lanjutkan menonton</h1>
    <div class="poster-strip">${items.map((m) => cardHtml(m, { continue: true })).join("")}</div>
  `;
  bindCards(pane);
  focusFirst(pane);
}

function renderWatchlist() {
  renderShell("", "watchlist");
  const pane = document.getElementById("main-pane");
  const items = loadWatchlist();
  if (items.length === 0) {
    pane.innerHTML = `
      <h1 class="page-title">Daftar tonton</h1>
      <p class="muted watchlist-empty">Belum ada judul tersimpan. Buka detail film atau serial lalu pilih <strong>Simpan ke daftar</strong>.</p>`;
    focusFirst(appEl);
    return;
  }
  pane.innerHTML = `
    <h1 class="page-title">Daftar tonton</h1>
    <p class="muted" style="margin:-8px 48px 16px">Simpan judul untuk ditonton nanti. Fokus kartu lalu pilih × untuk menghapus.</p>
    <p class="muted watchlist-empty" hidden>Daftar kosong.</p>
    <div class="poster-grid" id="watchlist-grid">
      ${items
        .map((item) =>
          cardHtml(watchlistToCatalog(item), {
            watchlist: true,
            removeKey: watchlistKey(item),
          })
        )
        .join("")}
    </div>
  `;
  bindCards(pane);
  bindWatchlistRemoves(pane);
  focusFirst(pane);
}

function renderSearch() {
  renderShell("", "search");
  const pane = document.getElementById("main-pane");
  pane.innerHTML = `
    <h1 class="page-title">Cari</h1>
    <form class="search-form" id="search-form">
      <input class="search-input" name="q" type="search" placeholder="Judul film atau serial…" />
      <button class="btn btn--primary" type="submit">Cari</button>
    </form>
    <div id="search-results"></div>
  `;
  const form = pane.querySelector("#search-form");
  const input = form.querySelector("input");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    const out = pane.querySelector("#search-results");
    if (!q) return;
    out.innerHTML = `<div class="loading">Mencari…</div>`;
    try {
      const res = await IdlixApi.search(q);
      const results = res.results || [];
      if (results.length === 0) {
        out.innerHTML = `<p>Tidak ada hasil.</p>`;
        return;
      }
      out.innerHTML = `<div class="poster-grid">${results
        .map((m) => cardHtml(mapSearchItem(m)))
        .join("")}</div>`;
      bindCards(out);
    } catch (e) {
      out.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
    }
  });
  input.focus();
}

function mapSearchItem(r) {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    contentType: r.contentType || "movie",
  };
}

function renderSettings() {
  renderShell("", "settings");
  const pane = document.getElementById("main-pane");
  const current = getBaseUrl();
  const proxyPref = getPlaybackProxyUrl();
  pane.innerHTML = `
    <h1 class="page-title">Pengaturan</h1>
    <div class="settings-block">
      <label for="backend-url">URL backend API</label>
      <input id="backend-url" type="url" value="${escapeHtml(current)}" autocomplete="off" />
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn--primary" type="button" id="save-backend">Simpan</button>
      </div>
      <p style="color:#a3a3a3;font-size:14px;margin-top:12px">Default: https://z2.idlixku.com/</p>
    </div>
    <div class="settings-block">
      <label for="playback-proxy">URL proxy PC (npm run serve:node)</label>
      <input id="playback-proxy" type="url" placeholder="kosongkan untuk TV saja" value="${escapeHtml(proxyPref)}" autocomplete="off" />
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn--primary" type="button" id="save-proxy">Simpan proxy</button>
      </div>
      <p style="color:#a3a3a3;font-size:14px;margin-top:12px">Jika diisi, TV memakai PC ini (Luna dilewati). Pakai IP LAN, bukan 127.0.0.1: http://192.168.x.x:5173 dari npm run serve:node, satu Wi‑Fi. Kosongkan untuk proxy bawaan TV.</p>
    </div>
    <div class="settings-block">
      <button class="btn btn--secondary" type="button" id="clear-history">Hapus riwayat tontonan</button>
      <button class="btn btn--secondary" type="button" id="clear-watchlist" style="margin-top:12px">Hapus daftar tonton</button>
    </div>
  `;
  pane.querySelector("#save-backend").addEventListener("click", () => {
    const v = pane.querySelector("#backend-url").value.trim();
    setBaseUrl(v || DEFAULT_BACKEND);
    alert("Tersimpan.");
  });
  pane.querySelector("#save-proxy").addEventListener("click", () => {
    setPlaybackProxyUrl(pane.querySelector("#playback-proxy").value.trim());
    alert("Proxy tersimpan.");
  });
  pane.querySelector("#clear-history").addEventListener("click", () => {
    if (confirm("Hapus semua riwayat?")) clearAllHistory();
  });
  pane.querySelector("#clear-watchlist").addEventListener("click", () => {
    if (confirm("Hapus semua judul di daftar tonton?")) clearWatchlist();
  });
  focusFirst(pane);
}

async function renderDetail(contentType, slug) {
  renderShell(`<div class="loading">Memuat detail…</div>`, contentType === "movie" ? "movies" : "series");
  const pane = document.getElementById("main-pane");
  try {
    if (contentType === "movie") {
      const movie = await IdlixApi.getMovieDetail(slug);
      prewarmStream("movie", movie.id, movie.title);
      pane.innerHTML = `
        <div style="position:relative;min-height:70vh">
          <div class="detail-backdrop" style="background-image:url('${backdropUrl(movie.backdropPath)}')"></div>
          <div class="detail-layout">
            <div class="detail-poster"><img alt="" src="${posterUrl(movie.posterPath)}" /></div>
            <div class="detail-body">
              <h1>${escapeHtml(movie.title)}</h1>
              <div class="detail-meta">${escapeHtml(movie.releaseDate || "")} · ⭐ ${escapeHtml(
                movie.voteAverage || "N/A"
              )}</div>
              <p class="detail-overview">${escapeHtml(movie.overview || "")}</p>
              <div class="btn-row">
                <button class="btn btn--primary" type="button" id="play-movie">Putar</button>
                <button class="btn btn--secondary" type="button" id="watchlist-toggle">Simpan ke daftar</button>
                <button class="btn btn--secondary" type="button" id="back-detail">Kembali</button>
              </div>
            </div>
          </div>
        </div>`;
      pane.querySelector("#play-movie").addEventListener("click", () => {
        openPlayer({
          contentType: "movie",
          contentId: movie.id,
          title: movie.title,
          poster: posterUrl(movie.posterPath),
          backdrop: backdropUrl(movie.backdropPath),
          slug: movie.slug,
        });
      });
      const wlBtn = pane.querySelector("#watchlist-toggle");
      updateWatchlistButton(wlBtn, "movie", movie.id, movie.slug);
      wlBtn?.addEventListener("click", () => {
        toggleWatchlist({
          contentId: movie.id,
          contentType: "movie",
          slug: movie.slug,
          title: movie.title,
          posterUrl: posterUrl(movie.posterPath),
          backdropUrl: backdropUrl(movie.backdropPath),
        });
        updateWatchlistButton(wlBtn, "movie", movie.id, movie.slug);
      });
    } else {
      const series = await IdlixApi.getSeriesDetail(slug);
      let seasonDetail = series.defaultSeason;
      if (!seasonDetail?.episodes?.length && (series.seasons?.length || 0) > 0) {
        for (const s of series.seasons) {
          const det = await IdlixApi.getEpisodeDetail(series.slug, s.seasonNumber, 1).catch(
            () => null
          );
          const eps = det?.season?.episodes;
          if (eps?.length) {
            seasonDetail = det.season;
            break;
          }
        }
      }
      const episodes = seasonDetail?.episodes || [];
      const seasonNumber =
        seasonDetail?.seasonNumber ?? series.seasons?.[0]?.seasonNumber ?? 1;
      const firstEp = episodes[0];
      if (firstEp) prewarmStream("episode", firstEp.id, `${series.title} - ${firstEp.name}`);

      pane.innerHTML = `
        <div style="position:relative;min-height:70vh">
          <div class="detail-backdrop" style="background-image:url('${backdropUrl(series.backdropPath)}')"></div>
          <div class="detail-layout">
            <div class="detail-poster"><img alt="" src="${posterUrl(series.posterPath)}" /></div>
            <div class="detail-body">
              <h1>${escapeHtml(series.title)}</h1>
              <div class="detail-meta">Serial · ${episodes.length} episode</div>
              <p class="detail-overview">${escapeHtml(series.overview || "")}</p>
              <div class="btn-row">
                <button class="btn btn--primary" type="button" id="play-series-first"${
                  !firstEp ? " disabled" : ""
                }>Putar episode 1</button>
                <button class="btn btn--secondary" type="button" id="watchlist-toggle">Simpan ke daftar</button>
                <button class="btn btn--secondary" type="button" id="back-detail">Kembali</button>
              </div>
              <h3 style="margin-top:32px">Episode</h3>
              <div class="episode-grid" id="ep-grid"></div>
            </div>
          </div>
        </div>`;
      const grid = pane.querySelector("#ep-grid");
      grid.innerHTML = episodes
        .map(
          (ep) => `
        <button class="episode-card" type="button" data-ep='${JSON.stringify({
          id: ep.id,
          name: ep.name,
          num: ep.episodeNumber,
        }).replace(/'/g, "&#39;")}'>
          <img alt="" src="${stillUrl(ep.stillPath)}" loading="lazy" />
          <div class="episode-card__body">
            <div class="episode-card__title">${escapeHtml(`E${ep.episodeNumber}: ${ep.name}`)}</div>
          </div>
        </button>`
        )
        .join("");
      pane.querySelector("#play-series-first")?.addEventListener("click", () => {
        if (!firstEp) return;
        openPlayer({
          contentType: "episode",
          contentId: firstEp.id,
          title: `${series.title} - ${firstEp.name}`,
          poster: stillUrl(firstEp.stillPath) || posterUrl(series.posterPath),
          backdrop: backdropUrl(series.backdropPath),
          slug: series.slug,
          season: seasonNumber,
          episode: firstEp.episodeNumber,
        });
      });
      const wlBtn = pane.querySelector("#watchlist-toggle");
      updateWatchlistButton(wlBtn, "tv_series", series.id, series.slug);
      wlBtn?.addEventListener("click", () => {
        toggleWatchlist({
          contentId: series.id,
          contentType: "tv_series",
          slug: series.slug,
          title: series.title,
          posterUrl: posterUrl(series.posterPath),
          backdropUrl: backdropUrl(series.backdropPath),
        });
        updateWatchlistButton(wlBtn, "tv_series", series.id, series.slug);
      });
      grid.querySelectorAll("[data-ep]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const ep = JSON.parse(btn.dataset.ep);
          openPlayer({
            contentType: "episode",
            contentId: ep.id,
            title: `${series.title} - ${ep.name}`,
            poster: stillUrl(ep.stillPath) || posterUrl(series.posterPath),
            backdrop: backdropUrl(series.backdropPath),
            slug: series.slug,
            season: seasonNumber,
            episode: ep.num,
          });
        });
      });
    }
    pane.querySelector("#back-detail")?.addEventListener("click", () => window.history.back());
    focusFirst(pane);
  } catch (e) {
    pane.innerHTML = `<div class="error">Gagal memuat detail: ${escapeHtml(e.message)}</div>`;
  }
}

function openPlayer(opts) {
  const q = new URLSearchParams();
  q.set("contentType", opts.contentType);
  q.set("contentId", opts.contentId);
  q.set("title", opts.title);
  if (opts.poster) q.set("poster", opts.poster);
  if (opts.backdrop) q.set("backdrop", opts.backdrop);
  if (opts.slug) q.set("slug", opts.slug);
  if (opts.season != null) q.set("season", String(opts.season));
  if (opts.episode != null) q.set("episode", String(opts.episode));
  navigate(`player?${q.toString()}`);
}

function subtitleTrackUrl(path, tokenQuery) {
  let abs = path.startsWith("http") ? path : new URL(path, getBaseUrl()).toString();
  if (tokenQuery && !/(?:\?|&)t=/.test(abs)) {
    abs += `${abs.indexOf("?") >= 0 ? "&" : "?"}${tokenQuery}`;
  }
  return proxyBase ? proxiedUrl(abs) : abs;
}

function parseVttTimestamp(ts) {
  const parts = String(ts || "")
    .trim()
    .split(":");
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = parseFloat(parts[0]);
    m = parseFloat(parts[1]);
    s = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    m = parseFloat(parts[0]);
    s = parseFloat(parts[1]);
  } else if (parts.length === 1) {
    s = parseFloat(parts[0]);
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return 0;
  return h * 3600 + m * 60 + s;
}

function parseWebVtt(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length) break;
    let line = lines[i].trim();
    i += 1;
    if (line === "WEBVTT" || line.startsWith("NOTE") || line.startsWith("STYLE")) continue;
    if (/^\d+$/.test(line) && i < lines.length) {
      line = lines[i].trim();
      i += 1;
    }
    const timing = line;
    const match = timing.match(/(\d[\d:.]*)\s*-->\s*(\d[\d:.]*)/);
    if (!match) continue;
    const start = parseVttTimestamp(match[1]);
    const end = parseVttTimestamp(match[2]);
    const body = [];
    while (i < lines.length && lines[i].trim() !== "") {
      body.push(
        lines[i]
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
      );
      i += 1;
    }
    const cueText = body.join("\n").trim();
    if (cueText && end > start) cues.push({ start, end, text: cueText });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function pickSubtitleMeta(tracks) {
  if (!tracks?.length) return null;
  return (
    tracks.find((t) => (t.lang || "").toLowerCase() === "id") ||
    tracks.find((t) => (t.label || "").toLowerCase().includes("indo")) ||
    tracks[0]
  );
}

async function fetchVttCues(url) {
  const init = { credentials: "omit", cache: "no-store" };
  let lastErr;
  const proxiedHop = /^https?:\/\/127\.0\.0\.1(:\d+)?\/p\?/i.test(String(url));
  const tries = proxiedHop && isWebOSTv() ? PROXY_FETCH_RETRIES : 1;
  let res;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      let target = url;
      if (attempt > 0) {
        resetProxyState();
        await ensureProxy({ force: true });
        const inner = unwrapProxied(url);
        target = proxyBase ? proxiedUrl(inner) : inner;
      }
      res = await fetch(target, init);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= tries || !isLikelyProxyConnError(err)) throw err;
    }
  }
  if (!res) throw lastErr || new Error("Subtitle fetch gagal");
  if (!res.ok) throw new Error(`Subtitle HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const data = await res.text();
  if (/<!DOCTYPE|<html/i.test(data) && !/WEBVTT/i.test(data)) {
    throw new Error("Subtitle bukan VTT");
  }
  const cues = parseWebVtt(data);
  if (!cues.length && !/WEBVTT/i.test(data)) {
    throw new Error(`Subtitle format tidak dikenali (${ct})`);
  }
  return cues;
}

function createSubtitleOverlay(container) {
  let layer = container.querySelector(".player-subs");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "player-subs";
    layer.setAttribute("aria-live", "polite");
    layer.innerHTML = '<div class="player-subs__text"></div>';
    container.appendChild(layer);
  }
  const textEl = layer.querySelector(".player-subs__text");
  return {
    textEl,
    dispose() {
      layer.remove();
    },
  };
}

function bindSubtitleSync(video, cues, textEl) {
  if (!cues.length) return () => {};
  let lastIdx = -1;
  const render = () => {
    const t = video.currentTime;
    let idx = -1;
    for (let j = 0; j < cues.length; j += 1) {
      const c = cues[j];
      if (t >= c.start && t < c.end) {
        idx = j;
        break;
      }
      if (c.start > t) break;
    }
    if (idx === lastIdx) return;
    lastIdx = idx;
    const active = idx >= 0 ? cues[idx] : null;
    textEl.textContent = active ? active.text : "";
  };
  video.addEventListener("timeupdate", render);
  video.addEventListener("seeking", render);
  video.addEventListener("seeked", render);
  render();
  return () => {
    video.removeEventListener("timeupdate", render);
    video.removeEventListener("seeking", render);
    video.removeEventListener("seeked", render);
    textEl.textContent = "";
  };
}

async function setupPlayerSubtitles(video, container, tracks, tokenQuery, preferNative) {
  const meta = pickSubtitleMeta(tracks);
  if (!meta?.path) return () => {};

  const url = subtitleTrackUrl(meta.path, tokenQuery);
  try {
    const cues = await fetchVttCues(url);
    if (cues.length) {
      const { textEl, dispose } = createSubtitleOverlay(container);
      const unbind = bindSubtitleSync(video, cues, textEl);
      return () => {
        unbind();
        dispose();
      };
    }
  } catch (_) {
    /* overlay failed — try native <track> */
  }

  if (preferNative) {
    attachSubtitleTracks(video, tracks, tokenQuery);
  }
  return () => {};
}

function enableDefaultSubtitles(video) {
  const list = video.textTracks;
  if (!list || !list.length) return;
  let pick = 0;
  for (let i = 0; i < list.length; i++) {
    const lang = (list[i].language || "").toLowerCase();
    const label = (list[i].label || "").toLowerCase();
    if (lang === "id" || lang.startsWith("id-") || label.includes("indo")) {
      pick = i;
      break;
    }
  }
  for (let i = 0; i < list.length; i++) {
    list[i].mode = i === pick ? "showing" : "hidden";
  }
}

function attachSubtitleTracks(video, tracks, tokenQuery) {
  /** @type {HTMLTrackElement[]} */
  const created = [];
  for (const t of tracks || []) {
    if (!t.path) continue;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = t.label || t.lang;
    track.srclang = t.lang || "id";
    track.src = subtitleTrackUrl(t.path, tokenQuery);
    track.default = created.length === 0;
    track.addEventListener("load", () => enableDefaultSubtitles(video));
    video.appendChild(track);
    created.push(track);
  }
  enableDefaultSubtitles(video);
  return created;
}

function destroyHls(hls) {
  if (hls) {
    hls.destroy();
  }
}

function loadHlsScript() {
  if (window.Hls) {
    return Promise.resolve(window.Hls);
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-idlix-hls="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Hls));
      existing.addEventListener("error", () => reject(new Error("Gagal memuat hls.bundle.js")));
      if (window.Hls) resolve(window.Hls);
      return;
    }
    const s = document.createElement("script");
    s.src = "hls.bundle.js";
    s.async = true;
    s.dataset.idlixHls = "1";
    s.onload = () => {
      if (window.Hls) resolve(window.Hls);
      else reject(new Error("Pemutar HLS tidak tersedia di perangkat ini"));
    };
    s.onerror = () => reject(new Error("File hls.bundle.js tidak ditemukan"));
    document.head.appendChild(s);
  });
}

function formatPlayerTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const ICON_PLAY_PAUSE = `
  <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><polygon points="7,4 20,12 7,20"></polygon></svg>
  <svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="5" height="16"></rect><rect x="14" y="4" width="5" height="16"></rect></svg>
`;

async function renderPlayer(params) {
  if (playerCleanup) {
    playerCleanup();
    playerCleanup = null;
  }

  const contentType = params.get("contentType") || "movie";
  const contentId = params.get("contentId") || "";
  const title = params.get("title") || "Memutar";
  const poster = params.get("poster") || "";
  const backdrop = params.get("backdrop") || "";
  const slug = params.get("slug") || "";
  const season = params.get("season");
  const episode = params.get("episode");

  document.documentElement.classList.add("player-active");
  document.body.classList.add("player-active");

  appEl.innerHTML = `
    <div class="player-root" id="player-root">
      <div class="player-video-wrap" id="player-stage" tabindex="-1">
        <video id="video" autoplay playsinline webkit-playsinline controlsList="nodownload"></video>
        <div class="player-chrome" id="player-overlay">
          <div class="player-top">
            <button class="player-back" type="button" id="btn-back">
              <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="15,4 7,12 15,20"></polygon></svg>
              <span>Kembali</span>
            </button>
            <h1 class="player-title">${escapeHtml(title)}</h1>
          </div>
          <div class="player-bottom">
            <p class="player-status" id="player-status">Menyiapkan stream…</p>
            <div class="player-seek">
              <button class="player-icon-btn" type="button" id="btn-play-bar" aria-label="Putar" disabled>
                ${ICON_PLAY_PAUSE}
              </button>
              <span class="player-time" id="time-now">0:00</span>
              <button class="player-track" type="button" id="seek-track" aria-label="Posisi tayangan">
                <span class="player-track__rail"><span class="player-track__fill" id="prog-bar"></span></span>
              </button>
              <span class="player-time player-time--end" id="time-end">0:00</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const video = document.getElementById("video");
  const overlay = document.getElementById("player-overlay");
  const statusEl = document.getElementById("player-status");
  const progBar = document.getElementById("prog-bar");
  const timeNow = document.getElementById("time-now");
  const timeEnd = document.getElementById("time-end");
  const seekTrack = document.getElementById("seek-track");
  const playerStage = document.getElementById("player-stage");
  const btnPlayBar = document.getElementById("btn-play-bar");
  const playButtons = [btnPlayBar];

  const seasonNum = season ? parseInt(season, 10) : null;
  const episodeNum = episode ? parseInt(episode, 10) : null;

  recordStartPlayback({
    contentId,
    contentType,
    title,
    posterUrl: poster,
    backdropUrl: backdrop,
    slug: slug || null,
    seasonNumber: Number.isFinite(seasonNum) ? seasonNum : null,
    episodeNumber: Number.isFinite(episodeNum) ? episodeNum : null,
    positionMs: getSavedPosition(contentId),
    durationMs: 0,
  });

  let hlsInstance = null;
  let detachSubtitles = () => {};
  let removed = false;
  let chromeSticky = true;
  let hasError = false;
  let streamReady = false;
  let setupLock = true;

  function leavePlayer() {
    cleanup();
    if (slug) {
      const kind = contentType === "movie" ? "movie" : "series";
      navigate(`detail/${kind}/${encodeURIComponent(slug)}`);
      return;
    }
    navigate("home");
  }

  function cleanup() {
    removed = true;
    document.documentElement.classList.remove("player-active");
    document.body.classList.remove("player-active");
    video.removeAttribute("src");
    video.load();
    destroyHls(hlsInstance);
    detachSubtitles();
    clearTimeout(controlsHideTimer);
    window.removeEventListener("keydown", onKey);
  }

  playerCleanup = cleanup;

  function scheduleChromeHide() {
    clearTimeout(controlsHideTimer);
    if (chromeSticky || hasError || video.paused || !streamReady) return;
    controlsHideTimer = setTimeout(hideChrome, CHROME_IDLE_MS);
  }

  function showChrome() {
    overlay.classList.remove("is-hidden");
    overlay.classList.remove("is-chrome-minimal");
    scheduleChromeHide();
  }

  function hideChrome() {
    if (chromeSticky || hasError || video.paused) return;
    overlay.classList.add("is-hidden");
  }

  function onPlayerPointerActivity() {
    if (!streamReady) return;
    showChrome();
  }

  function setPlayingUi(playing) {
    playButtons.forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle("is-playing", playing);
      btn.setAttribute("aria-label", playing ? "Jeda" : "Putar");
    });
  }

  function setControlsEnabled(on) {
    playButtons.forEach((btn) => {
      if (btn) btn.disabled = !on;
    });
  }

  function markStreamReady() {
    if (removed || streamReady) return;
    streamReady = true;
    chromeSticky = false;
    hasError = false;
    setControlsEnabled(true);
    setPlayingUi(!video.paused);
    if (/^Memuat |^Menghubungkan|^Menunggu/.test(statusEl.textContent || "")) {
      statusEl.textContent = "";
    }
    showChrome();
  }

  async function togglePlay() {
    if (!streamReady) return;
    showChrome();
    if (video.paused) {
      try {
        await video.play();
      } catch (err) {
        statusEl.textContent = (err && err.message) || "Tidak bisa memutar. Tekan Putar lagi.";
        showChrome();
      }
    } else {
      video.pause();
    }
  }

  function seekBy(deltaSec) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + deltaSec));
    showChrome();
  }

  function seekToRatio(ratio) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(1, Math.max(0, ratio)) * video.duration;
  }

  function onKey(ev) {
    const k = ev.key || "";
    if (k === "Escape" || k === "BrowserBack" || ev.keyCode === 461) {
      ev.preventDefault();
      leavePlayer();
      return;
    }
    if (k === "ArrowLeft") {
      ev.preventDefault();
      seekBy(-10);
      return;
    }
    if (k === "ArrowRight") {
      ev.preventDefault();
      seekBy(10);
      return;
    }
    if (k === " " || k === "MediaPlayPause" || ev.keyCode === 179 || ev.keyCode === 415 || ev.keyCode === 19) {
      ev.preventDefault();
      togglePlay();
      return;
    }
    if (k === "Enter" || ev.keyCode === 13) {
      const onBtn = ev.target && ev.target.closest && ev.target.closest("button");
      if (onBtn) return;
      ev.preventDefault();
      togglePlay();
      return;
    }
    if (
      streamReady &&
      (k === "ArrowUp" || k === "ArrowDown" || ev.keyCode === 38 || ev.keyCode === 40)
    ) {
      showChrome();
    }
  }
  window.addEventListener("keydown", onKey);

  document.getElementById("btn-back").addEventListener("click", (ev) => {
    ev.stopPropagation();
    leavePlayer();
  });
  playButtons.forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePlay();
    });
  });
  function onPlayerSurfaceClick(ev) {
    if (ev.target.closest("button")) return;
    if (!streamReady) return;
    togglePlay();
  }
  playerStage.addEventListener("click", onPlayerSurfaceClick);
  playerStage.addEventListener("mousemove", onPlayerPointerActivity);
  playerStage.addEventListener("pointermove", onPlayerPointerActivity);
  overlay.addEventListener("mousemove", onPlayerPointerActivity);
  overlay.addEventListener("pointermove", onPlayerPointerActivity);
  playerStage.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.keyCode === 13) {
      const onBtn = ev.target && ev.target.closest && ev.target.closest("button");
      if (onBtn) return;
      ev.preventDefault();
      if (streamReady) togglePlay();
    }
  });
  seekTrack.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const rail = seekTrack.querySelector(".player-track__rail") || seekTrack;
    const box = rail.getBoundingClientRect();
    if (!box.width) return;
    seekToRatio((ev.clientX - box.left) / box.width);
    showChrome();
  });

  const startPos = getSavedPosition(contentId);
  video.addEventListener("loadedmetadata", () => {
    timeEnd.textContent = formatPlayerTime(video.duration);
    if (startPos > 0 && video.currentTime < 1) {
      try {
        video.currentTime = startPos / 1000;
      } catch (_) {
        /* ignore */
      }
    }
    markStreamReady();
  });
  video.addEventListener("canplay", markStreamReady);

  video.addEventListener("timeupdate", () => {
    if (!video.duration || !Number.isFinite(video.duration)) return;
    const posMs = Math.floor(video.currentTime * 1000);
    const durMs = Math.floor(video.duration * 1000);
    updateProgress(contentId, posMs, durMs);
    if (progBar) {
      progBar.style.width = `${(video.currentTime / video.duration) * 100}%`;
    }
    timeNow.textContent = formatPlayerTime(video.currentTime);
    timeEnd.textContent = formatPlayerTime(video.duration);
  });

  video.addEventListener("playing", () => {
    statusEl.textContent = "";
    hasError = false;
    chromeSticky = false;
    setPlayingUi(true);
    showChrome();
  });

  video.addEventListener("pause", () => {
    setPlayingUi(false);
    clearTimeout(controlsHideTimer);
    overlay.classList.remove("is-hidden");
    overlay.classList.remove("is-chrome-minimal");
  });

  video.addEventListener("error", () => {
    if (setupLock || streamReady) return;
    const code = video.error ? video.error.code : 0;
    hasError = true;
    statusEl.textContent = `Gagal memutar video (kode ${code}). Tekan Putar atau Kembali.`;
    setControlsEnabled(streamReady);
    showChrome();
  });

  function showPlayerError(msg) {
    hasError = true;
    chromeSticky = true;
    statusEl.textContent = msg;
    showChrome();
  }

  try {
    statusEl.textContent = "Menghubungkan…";
    const resolved = await resolveStream(contentType, contentId, title, (sec) => {
      if (sec > 0) statusEl.textContent = `Menunggu ${sec}s…`;
      else statusEl.textContent = "Memuat video…";
    });
    if (removed) return;

    const masterUrl = resolved.hlsMasterUrl;
    if (!masterUrl) throw new Error("URL stream kosong.");
    if (isWebOSTv() || isLocalBrowser()) {
      await ensureProxy();
    } else {
      await ensureProxy().catch(() => "");
    }
    const playUrl = proxyBase ? proxiedUrl(masterUrl) : masterUrl;
    const tokenQuery = tokenQueryFromMaster(masterUrl);

    statusEl.textContent = "Memuat pemutar…";
    showChrome();

    let started = false;
    let usedMseHls = false;
    const canNative =
      video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL");

    const Hls = await loadHlsScript();
    let hlsNetworkRetries = 0;
    if (Hls.isSupported()) {
      usedMseHls = true;
      statusEl.textContent = "Memuat video…";
      hlsInstance = new Hls(buildHlsConfig(Hls, tokenQuery));
      hlsInstance.on(Hls.Events.ERROR, (_ev, data) => {
        if (!data) return;
        const detail = data.details || data.type || "unknown";
        const httpCode = data.response && data.response.code;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hlsNetworkRetries < 4) {
          hlsNetworkRetries += 1;
          try {
            hlsInstance.startLoad();
            return;
          } catch (_) {
            /* ignore */
          }
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hlsInstance.recoverMediaError();
            return;
          } catch (_) {
            /* ignore */
          }
        }
        if (!data.fatal) return;
        const hint = httpCode ? ` (HTTP ${httpCode})` : "";
        showPlayerError(
          `HLS: ${detail}${hint}. Cek Pengaturan URL proxy PC (npm run serve:node, IP LAN). Tekan Putar atau Kembali.`
        );
      });
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlayVideo(video);
      });
      hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => {
        tryPlayVideo(video);
      });
      hlsInstance.loadSource(playUrl);
      hlsInstance.attachMedia(video);
      started = await waitForVideoEvent(video, "playing", 8000);
      if (!started) {
        started = await tryPlayVideo(video);
      }
      if (!started && video.readyState < 1) {
        await waitForVideoEvent(video, "loadedmetadata", 8000);
      }
      started = !video.paused || video.readyState >= 1;
    } else if (canNative) {
      statusEl.textContent = "Memuat video…";
      started = await tryNativeHls(video, playUrl, 8000);
    } else {
      throw new Error("Perangkat tidak mendukung HLS.");
    }

    if (removed) return;
    streamReady = video.readyState >= 1 || started;
    if (!streamReady) {
      await waitForVideoEvent(video, "loadedmetadata", 8000);
      streamReady = video.readyState >= 1 || started;
    }
    if (!streamReady) throw new Error("Stream belum siap. Tekan Kembali lalu coba lagi.");

    setupLock = false;
    setControlsEnabled(true);
    chromeSticky = false;
    if (resolved.subtitles && resolved.subtitles.length) {
      detachSubtitles = await setupPlayerSubtitles(
        video,
        playerStage,
        resolved.subtitles,
        tokenQuery,
        !usedMseHls && canNative
      );
    }

    statusEl.textContent = "";
    await tryPlayVideo(video);
    if (video.paused) {
      setPlayingUi(false);
      statusEl.textContent = "Tekan Putar";
      showChrome();
      btnPlayBar.disabled = false;
      btnPlayBar.focus();
    } else {
      setPlayingUi(true);
      showChrome();
    }
  } catch (e) {
    setupLock = false;
    setControlsEnabled(false);
    showPlayerError((e && e.message) || "Terjadi kesalahan");
  }
}

// ——— Routing ———

async function route() {
  const { segments, params } = parseHash();
  const root = segments[0] || "home";

  if (playerCleanup) {
    playerCleanup();
    playerCleanup = null;
  }

  if (root === "home" || root === "") {
    await renderHome();
  } else if (root === "movies") {
    await renderList("movies");
  } else if (root === "series") {
    await renderList("series");
  } else if (root === "continue") {
    await renderContinue();
  } else if (root === "watchlist") {
    renderWatchlist();
  } else if (root === "search") {
    renderSearch();
  } else if (root === "settings") {
    renderSettings();
  } else if (root === "detail" && segments[1] && segments[2]) {
    await renderDetail(segments[1], decodeURIComponent(segments[2]));
  } else if (root === "player") {
    await renderPlayer(params);
  } else {
    navigate("home");
  }
}

window.addEventListener("hashchange", () => route());

function boot() {
  if (isWebOSTv()) {
    document.documentElement.classList.add("env-tv");
    document.body.classList.add("env-tv");
    ensureProxy().catch(() => {});
  }
  if (!appEl) {
    document.body.innerHTML =
      '<p style="padding:2rem;color:#fff;font-family:sans-serif">Kesalahan: #app tidak ditemukan</p>';
    return;
  }
  const hash = window.location.hash || "";
  if (!hash || hash === "#" || hash === "#/") {
    window.location.hash = "#/home";
  }
  route().catch((e) => {
    appEl.innerHTML = `<div class="error" style="padding:40px">${escapeHtml(
      (e && e.message) || String(e)
    )}</div>`;
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
