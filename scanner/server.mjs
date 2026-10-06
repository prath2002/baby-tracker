import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";

const TOKEN = process.env.SCANNER_TOKEN ?? "";
if (TOKEN.length < 24) { console.error("SCANNER_TOKEN must be at least 24 characters"); process.exit(1); }
const SOCK = ["/run/clamav/clamd.sock", "/tmp/clamd.sock"].find((p) => existsSync(p)) ?? "/run/clamav/clamd.sock";
const MAX = 21 * 1024 * 1024;
const ok = (h) => { const a = Buffer.from(h ?? ""), b = Buffer.from(`Bearer ${TOKEN}`); return a.length === b.length && timingSafeEqual(a, b); };

function scan(buf) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let out = "";
    s.setTimeout(40_000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("error", reject);
    s.on("connect", () => {
      s.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 65536) { const part = buf.subarray(i, i + 65536); const len = Buffer.alloc(4); len.writeUInt32BE(part.length); s.write(len); s.write(part); }
      s.write(Buffer.alloc(4));
    });
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out.replace(/\0/g, "").trim()));
  });
}

http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/scan") return send(404, { error: "not found" });
  if (!ok(req.headers.authorization)) return send(401, { error: "unauthorized" });
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > MAX) { send(413, { error: "too large" }); req.destroy(); } else chunks.push(c); });
  req.on("end", async () => {
    if (size > MAX) return;
    try {
      const r = await scan(Buffer.concat(chunks));
      if (/: OK$/.test(r)) return send(200, { clean: true });
      if (/FOUND$/.test(r)) return send(200, { infected: true, signature: r.replace(/^stream: /, "").replace(/ FOUND$/, "") });
      send(502, { error: "scanner error", detail: r });
    } catch (e) { send(503, { error: "scanner unavailable" }); }
  });
}).listen(8080, () => console.log("scanner listening on :8080"));
