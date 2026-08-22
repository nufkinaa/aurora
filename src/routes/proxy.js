// Web proxy powering the built-in browser page (/web). Rewrites HTML/CSS
// URLs so pages load through the server - useful on TVs with no browser.
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const express = require("express");

const router = express.Router();

// The proxy exists to browse the PUBLIC web from TVs. It must never be usable
// to reach into the LAN or this box itself (SSRF): every connection's address
// is checked at resolution time and refused if it is private, loopback,
// link-local (cloud metadata), or otherwise non-routable. The check lives in
// http.request's `lookup` hook so the address verified IS the address
// connected to — a DNS answer can't change between check and connect.
const isPrivateAddress = (addr) => {
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    if (a === "::" || a === "::1") return true;
    if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
    if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
    return false;
  }
  const p = addr.split(".").map(Number);
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
    (p[0] === 169 && p[1] === 254) ||              // link-local + cloud metadata
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
};
const guardedLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses)
      ? addresses
      : [{ address: addresses, family: options && options.family }];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error("refusing to proxy to a private or local address"));
    }
    if (options && options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

router.options("/proxy", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");
  res.status(204).send();
});

router.get("/proxy", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing URL parameter");

  let responseSent = false;
  const sendError = (status, title, message) => {
    if (responseSent) return;
    responseSent = true;
    res
      .status(status)
      .send(
        `<html><body style="font-family:sans-serif;padding:2rem;background:#0c0d14;color:#fff">` +
          `<h1>${title}</h1><p>${message}</p></body></html>`
      );
  };

  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return sendError(400, "Invalid URL", "Only http and https URLs can be proxied");
    }
    // Literal-IP hosts never reach the `lookup` hook (Node connects to them
    // directly), so they must be checked here.
    const literalHost = parsedUrl.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literalHost) && isPrivateAddress(literalHost)) {
      return sendError(403, "Blocked", "Refusing to proxy to a private or local address");
    }
    const baseOrigin = parsedUrl.origin;
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const proxyReq = protocol.request(
      targetUrl,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: {
          "User-Agent":
            req.headers["user-agent"] ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: req.headers["accept"] || "*/*",
          "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9,he;q=0.8",
          "Accept-Encoding": "gzip, deflate",
          Referer: baseOrigin + "/",
        },
        timeout: 20000,
      },
      (proxyRes) => {
        if (responseSent) return;

        if (
          proxyRes.statusCode >= 300 &&
          proxyRes.statusCode < 400 &&
          proxyRes.headers.location
        ) {
          let redirectUrl = proxyRes.headers.location;
          if (!redirectUrl.startsWith("http")) {
            redirectUrl = new URL(redirectUrl, targetUrl).href;
          }
          responseSent = true;
          return res.redirect("/proxy?url=" + encodeURIComponent(redirectUrl));
        }

        let stream = proxyRes;
        const contentEncoding = proxyRes.headers["content-encoding"];
        if (contentEncoding === "gzip") stream = proxyRes.pipe(zlib.createGunzip());
        else if (contentEncoding === "deflate") stream = proxyRes.pipe(zlib.createInflate());

        const body = [];
        stream.on("data", (chunk) => body.push(chunk));
        stream.on("end", () => {
          if (responseSent) return;
          responseSent = true;

          try {
            let content = Buffer.concat(body);
            const contentType = proxyRes.headers["content-type"] || "";
            const isHtml = contentType.includes("text/html");
            const isCss =
              contentType.includes("text/css") || /\.css(\?|$)/i.test(targetUrl);

            const toProxyUrl = (url) => {
              if (
                !url ||
                url.startsWith("data:") ||
                url.startsWith("blob:") ||
                url.startsWith("javascript:") ||
                url.startsWith("#") ||
                url.startsWith("mailto:") ||
                url.startsWith("tel:") ||
                url.startsWith("/proxy?url=")
              ) {
                return url;
              }
              try {
                return "/proxy?url=" + encodeURIComponent(new URL(url, targetUrl).href);
              } catch {
                return url;
              }
            };

            if (isHtml) {
              let html = content.toString("utf-8");

              html = html.replace(/\ssrc\s*=\s*(["'])([^"']+)\1/gi, (m, q, url) => ` src=${q}${toProxyUrl(url)}${q}`);
              html = html.replace(/\shref\s*=\s*(["'])([^"']+)\1/gi, (m, q, url) => ` href=${q}${toProxyUrl(url)}${q}`);
              html = html.replace(/\saction\s*=\s*(["'])([^"']+)\1/gi, (m, q, url) => ` action=${q}${toProxyUrl(url)}${q}`);
              html = html.replace(/\sposter\s*=\s*(["'])([^"']+)\1/gi, (m, q, url) => ` poster=${q}${toProxyUrl(url)}${q}`);
              html = html.replace(/\ssrcset\s*=\s*(["'])([^"']+)\1/gi, (m, q, srcset) => {
                const rewritten = srcset
                  .split(",")
                  .map((part) => {
                    const [url, size] = part.trim().split(/\s+/);
                    return toProxyUrl(url) + (size ? " " + size : "");
                  })
                  .join(", ");
                return ` srcset=${q}${rewritten}${q}`;
              });
              html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
                const newCss = css.replace(
                  /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
                  (m, q, url) => `url("${toProxyUrl(url)}")`
                );
                return match.replace(css, newCss);
              });
              html = html.replace(
                /style\s*=\s*(["'])([^"']*url\([^)]+\)[^"']*)\1/gi,
                (match, quote, style) => {
                  const newStyle = style.replace(
                    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
                    (m, q, url) => `url("${toProxyUrl(url)}")`
                  );
                  return `style=${quote}${newStyle}${quote}`;
                }
              );

              const injectedScript = `<script>
(function() {
  var BASE = '${baseOrigin}';
  function toProxy(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
    if (url.startsWith('/proxy?url=')) return url;
    try {
      var abs;
      if (url.startsWith('http://') || url.startsWith('https://')) abs = url;
      else if (url.startsWith('//')) abs = 'https:' + url;
      else if (url.startsWith('/')) abs = BASE + url;
      else abs = new URL(url, BASE).href;
      return '/proxy?url=' + encodeURIComponent(abs);
    } catch(e) { return url; }
  }
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = toProxy(input);
    else if (input && input.url) input = new Request(toProxy(input.url), input);
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = toProxy(url);
    return _open.apply(this, arguments);
  };
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (a && a.href) {
      e.preventDefault();
      var url = a.href;
      if (url.includes('/proxy?url=')) {
        var m = url.match(/[?&]url=([^&]+)/);
        if (m) url = decodeURIComponent(m[1]);
      }
      window.parent.postMessage({ type: 'navigate', url: url }, '*');
    }
  }, true);
})();
</script>`;

              if (html.includes("<head>")) {
                html = html.replace("<head>", "<head>" + injectedScript);
              } else if (html.includes("<head ")) {
                html = html.replace(/<head\s[^>]*>/i, (m) => m + injectedScript);
              } else if (html.includes("<html>")) {
                html = html.replace("<html>", "<html><head>" + injectedScript + "</head>");
              } else {
                html = injectedScript + html;
              }
              content = html;
            } else if (isCss) {
              let css = content.toString("utf-8");
              css = css.replace(
                /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
                (m, q, url) => `url("${toProxyUrl(url.trim())}")`
              );
              css = css.replace(
                /@import\s+(["'])([^"']+)\1/gi,
                (m, q, url) => `@import "${toProxyUrl(url)}"`
              );
              content = css;
            }

            if (contentType) res.set("Content-Type", contentType.split(";")[0]);
            res.set("Access-Control-Allow-Origin", "*");
            res.send(content);
          } catch (err) {
            sendError(500, "Parse Error", err.message);
          }
        });

        stream.on("error", () => sendError(502, "Connection Error", "Failed to load resource"));
      }
    );

    proxyReq.on("error", (err) => sendError(502, "Connection Error", err.message));
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      sendError(504, "Timeout", "Request timed out");
    });
    req.on("close", () => {
      if (!responseSent) {
        responseSent = true;
        proxyReq.destroy();
      }
    });

    proxyReq.end();
  } catch (err) {
    sendError(400, "Invalid URL", err.message);
  }
});

module.exports = router;
