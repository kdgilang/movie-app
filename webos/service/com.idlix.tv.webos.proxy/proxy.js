/**
 * webOS JS service: outbound HTTP with the same headers as Android OkHttp
 * (ApiClient.kt headerInterceptor). Browsers cannot set Origin; Node can.
 * Prefers system curl (cookies, gzip, redirects). Luna proxyFetch bypasses
 * loopback HTTP when WebAppManager cannot reach 127.0.0.1.
 */
var Service = require("webos-service");
var http = require("http");
var https = require("https");
var urlMod = require("url");
var fs = require("fs");
var spawn = require("child_process").spawn;

var SITE = "https://z2.idlixku.com/";
var ANDROID_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var COOKIE_JAR = "/tmp/com.idlix.tv.webos.proxy.cookies";

var ANDROID_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": ANDROID_UA,
  Referer: SITE,
  Origin: "https://z2.idlixku.com",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
};

var service = new Service("com.idlix.tv.webos.proxy");
var httpServer = null;
var proxyBase = "";
var curlBin = null;
var warmed = false;

function corsHeaders(extra) {
  var h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
  };
  if (extra) {
    Object.keys(extra).forEach(function (k) {
      if (k && extra[k] != null) h[k] = extra[k];
    });
  }
  return h;
}

function resolveUrl(base, rel) {
  try {
    return urlMod.resolve(base, rel);
  } catch (e) {
    return rel;
  }
}

function wrapProxy(absUrl) {
  return proxyBase + "/p?u=" + encodeURIComponent(absUrl);
}

function tokenQueryFromPlaylistUrl(playlistUrl) {
  try {
    var u = urlMod.parse(playlistUrl, true);
    var q = u.query || {};
    if (q.t) return "t=" + encodeURIComponent(q.t);
    var search = u.search || "";
    return search.length > 1 ? search.slice(1) : "";
  } catch (e) {
    return "";
  }
}

function withStreamToken(abs, tokenQuery) {
  if (!tokenQuery || /(?:\?|&)t=/.test(abs)) return abs;
  return abs + (abs.indexOf("?") >= 0 ? "&" : "?") + tokenQuery;
}

function rewritePlaylist(body, playlistUrl, wrapFn) {
  var tokenQuery = tokenQueryFromPlaylistUrl(playlistUrl);
  var wrap = wrapFn || function (abs) {
    return wrapProxy(abs);
  };
  var toAbs = function (rel) {
    return withStreamToken(resolveUrl(playlistUrl, rel), tokenQuery);
  };
  var lines = body.split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.replace(/^\s+|\s+$/g, "");
    if (!trimmed) {
      out.push(line);
    } else if (trimmed.charAt(0) === "#") {
      out.push(
        line.replace(/URI="([^"]+)"/g, function (_m, uri) {
          return 'URI="' + wrap(toAbs(uri)) + '"';
        })
      );
    } else {
      out.push(wrap(toAbs(trimmed)));
    }
  }
  return out.join("\n");
}

function looksLikePlaylist(contentType, body, targetUrl) {
  if (/mpegurl|m3u8|x-mpeg/i.test(contentType || "")) return true;
  if (/\.m3u8(\?|$)/i.test(targetUrl || "")) return true;
  var head = String(body || "")
    .replace(/^\uFEFF/, "")
    .replace(/^\s+/, "")
    .slice(0, 16);
  return head.indexOf("#EXTM3U") === 0;
}

function header(req, name) {
  return req.headers[name.toLowerCase()];
}

function collectBody(req, cb) {
  var chunks = [];
  req.on("data", function (c) {
    chunks.push(c);
  });
  req.on("end", function () {
    cb(Buffer.concat(chunks));
  });
  req.on("error", function () {
    cb(Buffer.alloc(0));
  });
}

function outboundHeaders(extraCookie, contentType) {
  var h = {};
  Object.keys(ANDROID_HEADERS).forEach(function (k) {
    h[k] = ANDROID_HEADERS[k];
  });
  if (contentType) h["Content-Type"] = contentType;
  if (extraCookie) h["Cookie"] = extraCookie;
  return h;
}

function findCurl() {
  if (curlBin !== null) return curlBin;
  var bins = ["/usr/bin/curl", "/bin/curl"];
  for (var i = 0; i < bins.length; i++) {
    try {
      if (fs.existsSync(bins[i])) {
        curlBin = bins[i];
        return curlBin;
      }
    } catch (e) {
      /* ignore */
    }
  }
  curlBin = "";
  return curlBin;
}

function nodeFetch(targetUrl, method, headers, bodyBuf, cb) {
  var parsed;
  try {
    parsed = urlMod.parse(targetUrl);
  } catch (e) {
    cb(e);
    return;
  }
  var lib = parsed.protocol === "http:" ? http : https;
  var m = method === "HEAD" ? "GET" : method || "GET";
  var opts = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    method: m,
    headers: headers,
    timeout: 45000,
    rejectUnauthorized: true,
  };
  var up = lib.request(opts, function (upRes) {
    var chunks = [];
    upRes.on("data", function (c) {
      chunks.push(c);
    });
    upRes.on("end", function () {
      cb(null, {
        status: upRes.statusCode || 502,
        contentType: String(upRes.headers["content-type"] || ""),
        body: Buffer.concat(chunks),
        via: "node",
      });
    });
  });
  up.on("timeout", function () {
    up.destroy();
  });
  up.on("error", function (err) {
    cb(err);
  });
  if (bodyBuf && bodyBuf.length && m !== "GET" && m !== "HEAD") {
    up.write(bodyBuf);
  }
  up.end();
}

function curlFetch(targetUrl, method, headers, bodyBuf, cb) {
  var bin = findCurl();
  if (!bin) {
    cb(new Error("curl missing"));
    return;
  }
  var m = method || "GET";
  var args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    "45",
    "-w",
    "\n__CURL_META__:%{http_code}|%{content_type}",
    "-X",
    m,
    "-A",
    ANDROID_UA,
    "-b",
    COOKIE_JAR,
    "-c",
    COOKIE_JAR,
  ];
  Object.keys(headers).forEach(function (k) {
    args.push("-H", k + ": " + headers[k]);
  });
  if (bodyBuf && bodyBuf.length && m !== "GET" && m !== "HEAD") {
    args.push("--data-binary", "@-");
  }
  args.push(targetUrl);
  var child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  var out = [];
  var errOut = [];
  child.stdout.on("data", function (c) {
    out.push(c);
  });
  child.stderr.on("data", function (c) {
    errOut.push(c);
  });
  child.on("error", function (err) {
    cb(err);
  });
  child.on("close", function (code) {
    var raw = Buffer.concat(out);
    var latin1 = raw.toString("binary");
    var status = code === 0 ? 200 : 502;
    var contentType = "";
    var mark = "\n__CURL_META__:";
    var idx = latin1.lastIndexOf(mark);
    var buf = raw;
    if (idx >= 0) {
      var meta = raw.slice(idx + mark.length).toString("utf8").replace(/^\s+|\s+$/g, "");
      var parts = meta.split("|");
      status = parseInt(parts[0], 10) || status;
      contentType = parts[1] || "";
      buf = raw.slice(0, idx);
    } else if (errOut.length && code !== 0) {
      cb(new Error(Buffer.concat(errOut).toString("utf8") || "curl failed"));
      return;
    }
    cb(null, {
      status: status,
      contentType: contentType,
      body: buf,
      via: "curl",
    });
  });
  if (bodyBuf && bodyBuf.length && m !== "GET" && m !== "HEAD") {
    child.stdin.write(bodyBuf);
  }
  child.stdin.end();
}

function upstreamFetch(targetUrl, method, extraCookie, contentType, bodyBuf, cb) {
  var headers = outboundHeaders(extraCookie, contentType);
  if (findCurl()) {
    curlFetch(targetUrl, method, headers, bodyBuf, function (err, result) {
      if (!err && result) {
        cb(null, result);
        return;
      }
      nodeFetch(targetUrl, method, headers, bodyBuf, cb);
    });
    return;
  }
  nodeFetch(targetUrl, method, headers, bodyBuf, cb);
}

function warmup(cb) {
  if (warmed) {
    if (cb) cb();
    return;
  }
  upstreamFetch(SITE, "GET", "", "", null, function () {
    warmed = true;
    if (cb) cb();
  });
}

function maybeRewrite(targetUrl, result) {
  var ct = result.contentType || "";
  var body = result.body || new Buffer(0);
  var text = body.toString("utf8");
  if (looksLikePlaylist(ct, text, targetUrl)) {
    var rewritten = rewritePlaylist(text, targetUrl, function (abs) {
      return wrapProxy(abs);
    });
    return {
      status: result.status,
      contentType: "application/vnd.apple.mpegurl",
      body: new Buffer(rewritten, "utf8"),
      via: result.via,
    };
  }
  return result;
}

function handleProxy(req, res, targetUrl) {
  var parsed;
  try {
    parsed = urlMod.parse(targetUrl);
  } catch (e) {
    res.writeHead(400, corsHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Bad target URL" }));
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.writeHead(400, corsHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Only http/https" }));
    return;
  }

  var method = req.method === "HEAD" ? "GET" : req.method || "GET";

  function sendUpstream(bodyBuf) {
    var extraCookie = header(req, "x-idlix-cookie") || "";
    var ct = header(req, "content-type") || "";
    upstreamFetch(targetUrl, method, extraCookie, ct, bodyBuf, function (err, result) {
      if (err) {
        if (!res.headersSent) {
          res.writeHead(502, corsHeaders({ "Content-Type": "application/json" }));
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }
      result = maybeRewrite(targetUrl, result);
      var outCt = result.contentType || "application/octet-stream";
      res.writeHead(result.status || 502, corsHeaders({ "Content-Type": outCt }));
      res.end(result.body);
    });
  }

  if (method === "POST" || method === "PUT" || method === "PATCH") {
    collectBody(req, sendUpstream);
  } else {
    sendUpstream(null);
  }
}

function onRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  var parsed = urlMod.parse(req.url, true);
  var pathname = parsed.pathname || "";
  if (pathname === "/health") {
    res.writeHead(200, corsHeaders({ "Content-Type": "application/json" }));
    res.end(
      JSON.stringify({
        ok: true,
        base: proxyBase,
        onDevice: true,
        chromium: false,
        curl: !!findCurl(),
        warmed: warmed,
      })
    );
    return;
  }
  if (pathname === "/p" || pathname === "/p/") {
    var target = (parsed.query && parsed.query.u) || "";
    if (!target) {
      res.writeHead(400, corsHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: "missing u" }));
      return;
    }
    handleProxy(req, res, target);
    return;
  }
  res.writeHead(404, corsHeaders({ "Content-Type": "application/json" }));
  res.end(JSON.stringify({ error: "not found" }));
}

function serverListening() {
  try {
    return !!(httpServer && httpServer.listening);
  } catch (e) {
    return !!(httpServer && proxyBase);
  }
}

function ensureServer(cb) {
  if (serverListening() && proxyBase) {
    cb(null, { port: urlMod.parse(proxyBase).port, base: proxyBase });
    return;
  }
  if (httpServer && !serverListening()) {
    try {
      httpServer.close();
    } catch (e) {
      /* ignore */
    }
    httpServer = null;
    proxyBase = "";
  }
  try {
    httpServer = http.createServer(onRequest);
    httpServer.on("error", function (err) {
      cb(err);
    });
    httpServer.listen(0, "127.0.0.1", function () {
      var addr = httpServer.address();
      var port = addr && addr.port;
      proxyBase = "http://127.0.0.1:" + port;
      cb(null, { port: port, base: proxyBase });
    });
  } catch (e) {
    cb(e);
  }
}

function keepAlive() {
  try {
    service.activityManager.create("idlix-proxy-keepalive", function () {});
  } catch (e) {
    /* older firmware */
  }
}

function respondFetch(message, err, result, targetUrl) {
  if (err) {
    message.respond({
      returnValue: false,
      errorCode: 1,
      errorText: String(err.message || err),
    });
    return;
  }
  result = maybeRewrite(targetUrl, result);
  var text = (result.body || new Buffer(0)).toString("utf8");
  if (text.length > 900000) {
    text = text.slice(0, 900000);
  }
  message.respond({
    returnValue: true,
    status: result.status || 0,
    contentType: result.contentType || "",
    body: text,
    via: result.via || "",
  });
}

service.register("startProxy", function (message) {
  ensureServer(function (err, info) {
    if (err) {
      message.respond({
        returnValue: false,
        errorCode: 1,
        errorText: String(err.message || err),
      });
      return;
    }
    keepAlive();
    warmup(function () {});
    message.respond({
      returnValue: true,
      port: Number(info.port),
      base: info.base,
      curl: !!findCurl(),
    });
  });
});

service.register("proxyFetch", function (message) {
  keepAlive();
  var p = message.payload || {};
  var targetUrl = p.url || "";
  var method = p.method || "GET";
  var extraCookie = p.cookie || "";
  var contentType = p.contentType || "";
  var bodyStr = p.body || "";
  if (!targetUrl) {
    message.respond({
      returnValue: false,
      errorCode: 2,
      errorText: "missing url",
    });
    return;
  }
  var parsed;
  try {
    parsed = urlMod.parse(targetUrl);
  } catch (e) {
    message.respond({
      returnValue: false,
      errorCode: 3,
      errorText: "Bad target URL",
    });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    message.respond({
      returnValue: false,
      errorCode: 4,
      errorText: "Only http/https",
    });
    return;
  }
  var bodyBuf = bodyStr ? new Buffer(bodyStr, "utf8") : null;
  function run() {
    upstreamFetch(targetUrl, method, extraCookie, contentType, bodyBuf, function (err, result) {
      respondFetch(message, err, result, targetUrl);
    });
  }
  if (!warmed) {
    warmup(run);
  } else {
    run();
  }
});

service.register("ping", function (message) {
  message.respond({
    returnValue: true,
    base: proxyBase || "",
    running: serverListening(),
    curl: !!findCurl(),
    warmed: warmed,
  });
});
