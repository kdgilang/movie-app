/**
 * webOS JS service: outbound HTTP with the same headers as Android OkHttp
 * (ApiClient.kt headerInterceptor). Browsers cannot set Origin; Node can.
 */
var Service = require("webos-service");
var http = require("http");
var https = require("https");
var urlMod = require("url");

var ANDROID_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var ANDROID_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": ANDROID_UA,
  Referer: "https://z2.idlixku.com/",
  Origin: "https://z2.idlixku.com",
};

var service = new Service("com.idlix.tv.webos.proxy");
var httpServer = null;
var proxyBase = "";

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

function rewriteTagLine(line, playlistUrl) {
  return line.replace(/URI="([^"]+)"/g, function (_m, uri) {
    return 'URI="' + wrapProxy(resolveUrl(playlistUrl, uri)) + '"';
  });
}

function rewritePlaylist(body, playlistUrl) {
  var lines = body.split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
    } else if (trimmed.charAt(0) === "#") {
      out.push(rewriteTagLine(line, playlistUrl));
    } else {
      out.push(wrapProxy(resolveUrl(playlistUrl, trimmed)));
    }
  }
  return out.join("\n");
}

function looksLikePlaylist(contentType, body, targetUrl) {
  if (/mpegurl|m3u8|x-mpeg/i.test(contentType || "")) return true;
  if (/\.m3u8(\?|$)/i.test(targetUrl || "")) return true;
  var head = (body || "").slice(0, 16);
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

function outboundHeaders(incoming) {
  var h = {};
  Object.keys(ANDROID_HEADERS).forEach(function (k) {
    h[k] = ANDROID_HEADERS[k];
  });
  var ct = header(incoming, "content-type");
  if (ct) h["Content-Type"] = ct;
  var cookie = header(incoming, "x-idlix-cookie");
  if (cookie) h["Cookie"] = cookie;
  return h;
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

  var lib = parsed.protocol === "http:" ? http : https;
  var method = req.method === "HEAD" ? "GET" : req.method || "GET";

  function sendUpstream(bodyBuf) {
    var opts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: method,
      headers: outboundHeaders(req),
      timeout: 45000,
      rejectUnauthorized: true,
    };
    var up = lib.request(opts, function (upRes) {
      var ct = String(upRes.headers["content-type"] || "");
      var peekText =
        /m3u8|mpegurl|json|text|xml|javascript/i.test(ct) ||
        /\.m3u8(\?|$)/i.test(targetUrl);

      if (!peekText) {
        var hop = corsHeaders({
          "Content-Type": ct || "application/octet-stream",
        });
        if (upRes.headers["content-length"]) {
          hop["Content-Length"] = upRes.headers["content-length"];
        }
        res.writeHead(upRes.statusCode || 502, hop);
        upRes.pipe(res);
        return;
      }

      var chunks = [];
      upRes.on("data", function (c) {
        chunks.push(c);
      });
      upRes.on("end", function () {
        var buf = Buffer.concat(chunks);
        var body = buf.toString("utf8");
        var outHeaders = corsHeaders({
          "Content-Type": ct || "text/plain; charset=utf-8",
        });
        if (looksLikePlaylist(ct, body, targetUrl)) {
          body = rewritePlaylist(body, targetUrl);
          outHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
          res.writeHead(upRes.statusCode || 200, outHeaders);
          res.end(body);
        } else {
          res.writeHead(upRes.statusCode || 200, outHeaders);
          res.end(buf);
        }
      });
    });
    up.on("timeout", function () {
      up.destroy();
    });
    up.on("error", function (err) {
      if (!res.headersSent) {
        res.writeHead(502, corsHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    if (bodyBuf && bodyBuf.length && method !== "GET" && method !== "HEAD") {
      up.write(bodyBuf);
    }
    up.end();
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
    res.end(JSON.stringify({ ok: true, base: proxyBase }));
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

function ensureServer(cb) {
  if (httpServer && proxyBase) {
    cb(null, { port: urlMod.parse(proxyBase).port, base: proxyBase });
    return;
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
    message.respond({
      returnValue: true,
      port: Number(info.port),
      base: info.base,
    });
  });
});

service.register("ping", function (message) {
  message.respond({
    returnValue: true,
    base: proxyBase || "",
    running: !!httpServer,
  });
});
