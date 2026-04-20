const http = require("http");
const httpProxy = require("http-proxy");
const zlib = require("zlib");

const TARGET = process.env.TARGET || "http://localhost:3080";
const PORT = parseInt(process.env.PORT || "3000");

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  selfHandleResponse: true,
  changeOrigin: true,
});

// All hostnames that refer to the same NAS — local, .local, Tailscale, etc.
const NAS_HOSTNAMES = (process.env.NAS_HOSTNAMES || "nas,nas-docker")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

console.log(`[init] NAS_HOSTNAMES: ${JSON.stringify(NAS_HOSTNAMES)}`);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace NAS aliases only in navigable links (href, src, action attributes)
function rewriteBody(body, toHost) {
  let result = body;
  let totalReplaced = 0;

  function rewriteLinkUrl(url, aliasEscaped) {
    return url
      // Preserve original scheme (http or https) when rewriting hostname.
      .replace(
        new RegExp(`^(https?:)//${aliasEscaped}(?=:\\d+|[/?#]|$)`, "i"),
        `$1//${toHost}`
      )
      .replace(
        new RegExp(`^//${aliasEscaped}(?=:\\d+|[/?#]|$)`, "i"),
        `//${toHost}`
      );
  }

  for (const alias of NAS_HOSTNAMES) {
    if (alias === toHost) continue;

    const esc = escapeRegex(alias);
    let count = 0;

    // Pattern 1: HTML attributes with navigable URLs.
    const p1 = new RegExp(
      `((?:href|src|action)\\s*=\\s*)(["'])([^"']*?(?:https?://|//)${esc}(?=:\\d+|[/?#]|$)[^"']*)\\2`,
      "gi"
    );
    result = result.replace(p1, (match, attr, quote, url) => {
      const rewritten = rewriteLinkUrl(url, esc);
      if (rewritten !== url) {
        count++;
      }
      return `${attr}${quote}${rewritten}${quote}`;
    });

    // Pattern 2: JSON-style link fields in payloads.
    const p2 = new RegExp(
      `(["'](?:href|url|link|redirect)["']\\s*:\\s*)(["'])([^"']*?(?:https?://|//)${esc}(?=:\\d+|[/?#]|$)[^"']*)\\2`,
      "gi"
    );
    result = result.replace(p2, (match, key, quote, url) => {
      const rewritten = rewriteLinkUrl(url, esc);
      if (rewritten !== url) {
        count++;
      }
      return `${key}${quote}${rewritten}${quote}`;
    });

    // Pattern 3: Fallback for host-only references in attributes.
    const p3 = new RegExp(`((?:href|src|action)\\s*=\\s*)(["'])([^"']*${esc}(?::\\d+)?[^"']*)\\2`, "gi");
    result = result.replace(p3, (match, attr, quote, url) => {
      // Only replace full host tokens (avoid alias partial match inside larger hostnames).
      if (
        url.includes(toHost) ||
        !url.match(new RegExp(`(?<![a-z0-9-])${esc}(?=:\\d+|[/?#]|$)`, "i"))
      ) {
        return match;
      }
      
      const rewritten = url
        .replace(new RegExp(`(?<![a-z0-9-])${esc}(?=:\\d+|[/?#]|$)`, "gi"), toHost);
      if (rewritten !== url) {
        count++;
      }
      return `${attr}${quote}${rewritten}${quote}`;
    });

    if (count > 0) {
      console.log(`  [rewrite] "${alias}" → "${toHost}" : ${count} link(s)`);
      totalReplaced += count;
    }
  }

  return { result, totalReplaced };
}

function decompress(res, buffer, cb) {
  const encoding = res.headers["content-encoding"];
  if (encoding === "gzip") {
    zlib.gunzip(buffer, cb);
  } else if (encoding === "br") {
    zlib.brotliDecompress(buffer, cb);
  } else if (encoding === "deflate") {
    zlib.inflate(buffer, cb);
  } else {
    cb(null, buffer);
  }
}

proxy.on("proxyRes", function (proxyRes, req, res) {
  const reqHost = (req.headers.host || "").split(":")[0].toLowerCase();
  const contentType = proxyRes.headers["content-type"] || "";

  const isRewritable =
    contentType.includes("text/html") ||
    contentType.includes("application/json");

  const shouldRewrite = NAS_HOSTNAMES.includes(reqHost) && isRewritable;

  console.log(
    `[req] ${req.method} ${req.url} | host: "${reqHost}" | type: "${contentType.split(";")[0]}" | rewrite: ${shouldRewrite}`
  );

  const headers = { ...proxyRes.headers };
  if (shouldRewrite) {
    delete headers["content-encoding"];
    delete headers["content-length"];
  }
  res.writeHead(proxyRes.statusCode, headers);

  if (!shouldRewrite) {
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", () => {
    const buffer = Buffer.concat(chunks);
    decompress(proxyRes, buffer, (err, decoded) => {
      if (err) {
        console.error("Decompress error:", err);
        res.end(buffer);
        return;
      }
      const original = decoded.toString("utf8");

      const { result: rewritten, totalReplaced } = rewriteBody(original, reqHost);
      console.log(`[done] ${req.url} — ${totalReplaced} replacement(s) → "${reqHost}"`);
      res.end(Buffer.from(rewritten, "utf8"));
    });
  });
});

proxy.on("error", (err, req, res) => {
  console.error("[proxy error]", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  res.end(`Proxy error: ${err.message}`);
});

const server = http.createServer((req, res) => {
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`\nHomepage hostname proxy listening on :${PORT}`);
  console.log(`  → Target:    ${TARGET}`);
  console.log(`  → Hostnames: ${NAS_HOSTNAMES.join(", ")}`);
  console.log(`  → Rewrites all aliases to match the browser request hostname\n`);
});