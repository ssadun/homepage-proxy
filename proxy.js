const http = require("http");
const httpProxy = require("http-proxy");
const zlib = require("zlib");

const TARGET = process.env.TARGET || "http://localhost:3080";
const PORT = parseInt(process.env.PORT || "3000");
const VERSION = "1.1.0";

// Injected just before </body> on every HTML page
const VERSION_BADGE = `
<style>
  #hp-proxy-version {
    position: fixed;
    bottom: 8px;
    right: 12px;
    z-index: 9999;
    font-family: monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.55);
    pointer-events: none;
    user-select: none;
    letter-spacing: 0.03em;
  }
</style>
<div id="hp-proxy-version">proxy v${VERSION}</div>`;

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  selfHandleResponse: true,
  changeOrigin: true,
});

const NAS_HOSTNAMES = (process.env.NAS_HOSTNAMES || "nas,nas-docker")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

console.log(`[init] Target: ${TARGET}`);
console.log(`[init] Version: ${VERSION}`);
console.log(`[init] NAS_HOSTNAMES: ${NAS_HOSTNAMES.join(", ")}`);

// ---------------------------------------------------------------------------
// Core rewrite: one fast pass, replaces every occurrence of any alias.
//
// The only rule is: the alias must be followed by : / " ' whitespace or EOL,
// and must NOT be preceded by a letter, digit, dot or hyphen (to avoid partial
// matches inside longer hostnames like "other-nas:5055" matching alias "nas").
// ---------------------------------------------------------------------------
function buildRewritePattern(alias) {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9.\\-])${esc}(?=[:/\"'\`\\s)>,}\\]]|$)`, "g");
}

// Pre-compile all patterns at startup — not on every request
const ALIAS_PATTERNS = NAS_HOSTNAMES.map((alias) => ({
  alias,
  pattern: buildRewritePattern(alias),
}));

// Only rewrite navigational link fields (what the browser opens directly).
// Deliberately excludes "url"/"siteMonitor": those are fetched server-side by
// Homepage itself (widget data, monitor pings) using the real internal
// hostname. Rewriting them would point the backend's own outbound requests
// at the public-facing hostname/port, which usually isn't routable.
const JSON_LINK_KEY_PATTERN = /("(?:href|link|redirect)"\s*:\s*")([^"]*)(")/g;
const HTML_LINK_ATTR_PATTERN = /\b(href|src|action)(=["'])([^"']*)(["'])/g;

function replaceAliasesInValue(value, toHost) {
  let count = 0;
  let result = value;

  for (const { alias, pattern } of ALIAS_PATTERNS) {
    if (alias === toHost) continue;

    pattern.lastIndex = 0;
    const before = result;
    result = result.replace(pattern, toHost);

    if (result !== before) {
      pattern.lastIndex = 0;
      count += (before.match(pattern) || []).length;
    }
  }

  return { result, count };
}

function rewriteBody(body, toHost) {
  let totalReplaced = 0;

  let result = body.replace(JSON_LINK_KEY_PATTERN, (match, prefix, value, suffix) => {
    const { result: rewritten, count } = replaceAliasesInValue(value, toHost);
    totalReplaced += count;
    return `${prefix}${rewritten}${suffix}`;
  });

  result = result.replace(HTML_LINK_ATTR_PATTERN, (match, attr, sep, value, quote) => {
    const { result: rewritten, count } = replaceAliasesInValue(value, toHost);
    totalReplaced += count;
    return `${attr}${sep}${rewritten}${quote}`;
  });

  if (totalReplaced > 0) {
    console.log(`  [rewrite] -> "${toHost}" : ${totalReplaced} occurrence(s)`);
  }

  return { result, totalReplaced };
}

// Fast check: does the body contain any alias at all?
// Avoids decompress + rewrite overhead when nothing needs replacing.
function bodyContainsAlias(body, toHost) {
  for (const { alias } of ALIAS_PATTERNS) {
    if (alias === toHost) continue;
    if (body.includes(alias)) return true;
  }
  return false;
}

function decompress(res, buffer) {
  return new Promise((resolve, reject) => {
    const encoding = res.headers["content-encoding"];
    if (encoding === "gzip") {
      zlib.gunzip(buffer, (err, buf) => (err ? reject(err) : resolve(buf)));
    } else if (encoding === "br") {
      zlib.brotliDecompress(buffer, (err, buf) => (err ? reject(err) : resolve(buf)));
    } else if (encoding === "deflate") {
      zlib.inflate(buffer, (err, buf) => (err ? reject(err) : resolve(buf)));
    } else {
      resolve(buffer);
    }
  });
}

function isRewritable(contentType) {
  return (
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.includes("text/javascript") ||
    contentType.includes("application/javascript") ||
    contentType.includes("text/css")
  );
}

proxy.on("proxyRes", function (proxyRes, req, res) {
  const reqHost = (req.headers.host || "").split(":")[0].toLowerCase();
  const contentType = proxyRes.headers["content-type"] || "";
  const isHtml = contentType.includes("text/html");
  const shouldRewrite = NAS_HOSTNAMES.includes(reqHost) && isRewritable(contentType);

  const headers = { ...proxyRes.headers };

  if (!shouldRewrite) {
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
    return;
  }

  delete headers["content-encoding"];
  delete headers["content-length"];
  res.writeHead(proxyRes.statusCode, headers);

  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const decoded = await decompress(proxyRes, buffer);
      let body = decoded.toString("utf8");

      // Hostname rewrite
      if (bodyContainsAlias(body, reqHost)) {
        const { result, totalReplaced } = rewriteBody(body, reqHost);
        body = result;
        if (totalReplaced > 0) {
          console.log(`[done] ${req.method} ${req.url} — ${totalReplaced} replacement(s) -> "${reqHost}"`);
        }
      }

      // Inject version badge into HTML pages only.
      // Next.js may not emit a literal </body> so we try </body>, then </html>, then just append.
      if (isHtml) {
        const closeBody = body.lastIndexOf("</body>");
        const closeHtml = body.lastIndexOf("</html>");
        if (closeBody !== -1) {
          body = body.slice(0, closeBody) + VERSION_BADGE + "\n</body>" + body.slice(closeBody + 7);
        } else if (closeHtml !== -1) {
          body = body.slice(0, closeHtml) + VERSION_BADGE + "\n</html>" + body.slice(closeHtml + 7);
        } else {
          body += VERSION_BADGE;
        }
      }

      res.end(Buffer.from(body, "utf8"));
    } catch (err) {
      console.error(`[decompress error] ${req.url}:`, err.message);
      res.end(Buffer.concat(chunks));
    }
  });
});

proxy.on("error", (err, req, res) => {
  console.error("[proxy error]", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Proxy error: ${err.message}`);
  }
});

const server = http.createServer((req, res) => {
  // Debug endpoint — visit /proxy-debug in your browser to see proxy status
  if (req.url === "/proxy-debug") {
    const reqHost = (req.headers.host || "").split(":")[0].toLowerCase();
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end([
      `homepage-proxy v${VERSION}`,
      ``,
      `Request host : "${reqHost}"`,
      `Known hosts  : ${JSON.stringify(NAS_HOSTNAMES)}`,
      `Host matched : ${NAS_HOSTNAMES.includes(reqHost)}`,
      `Target       : ${TARGET}`,
      ``,
      `If "Host matched" is false, add "${reqHost}" to NAS_HOSTNAMES in your .env`,
    ].join("\n"));
    return;
  }
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`\nHomepage hostname proxy v${VERSION} listening on :${PORT}`);
  console.log(`  -> Target:    ${TARGET}`);
  console.log(`  -> Hostnames: ${NAS_HOSTNAMES.join(", ")}\n`);
});