import "server-only";
import { Socket } from "node:net";
import sharp from "sharp";
import { env, IS_PROD } from "./env";

export const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Magic-byte sniffing (spec §36): the declared type must match the actual bytes. */
export function sniffMime(b: Buffer): AllowedMime | null {
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = b.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
}

/** Rejects PDFs carrying active content (spec §26/Q15 default: reject). */
export function pdfActiveContent(b: Buffer): string | null {
  const s = b.toString("latin1");
  const patterns: [RegExp, string][] = [
    [/\/JavaScript\b/, "embedded JavaScript"], [/\/JS\s*[(<\[]/, "embedded JavaScript"], [/\/Launch\b/, "launch action"],
    [/\/EmbeddedFile\b/, "embedded file"], [/\/RichMedia\b/, "rich media"], [/\/XFA\b/, "XFA form"], [/\/AA\s*<</, "automatic action"],
  ];
  for (const [re, label] of patterns) if (re.test(s)) return label;
  return null;
}
export function pdfPageCount(b: Buffer): number | null {
  const m = b.toString("latin1").match(/\/Type\s*\/Page(?!s)\b/g);
  return m ? m.length : null;
}

/** Re-encodes images to strip EXIF/GPS and polyglot payloads. HEIC is converted to JPEG when the runtime can decode it. */
export async function sanitizeImage(b: Buffer, mime: AllowedMime): Promise<{ data: Buffer; mime: string }> {
  const img = sharp(b, { failOn: "error", limitInputPixels: 80_000_000 }).rotate(); // apply EXIF orientation then drop metadata
  if (mime === "image/png") return { data: await img.png({ compressionLevel: 9 }).toBuffer(), mime: "image/png" };
  if (mime === "image/webp") return { data: await img.webp({ quality: 90 }).toBuffer(), mime: "image/webp" };
  return { data: await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mime: "image/jpeg" };
}

export type ScanResult = { status: "CLEAN" | "INFECTED" | "ERROR"; detail: string };

/** Malware scan via clamd INSTREAM (spec §36). dev-allow is refused in production by assertSafeConfig(). */
export async function scanBuffer(b: Buffer): Promise<ScanResult> {
  if (env.SCANNER === "dev-allow" && !IS_PROD) {
    if (b.includes(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!"))) return { status: "INFECTED", detail: "Eicar-Test-Signature (dev scanner)" };
    return { status: "CLEAN", detail: "dev-allow scanner (development only)" };
  }
  if (env.SCANNER === "http" && env.SCANNER_URL) {
    try {
      const r = await fetch(env.SCANNER_URL.replace(/\/$/, "") + "/scan", { method: "POST", headers: { Authorization: `Bearer ${env.SCANNER_TOKEN}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(b), signal: AbortSignal.timeout(45_000) });
      if (!r.ok) return { status: "ERROR", detail: `Scanner HTTP ${r.status}` };
      const j = (await r.json()) as { clean?: boolean; infected?: boolean; signature?: string };
      if (j.infected) return { status: "INFECTED", detail: j.signature ?? "Malware detected" };
      if (j.clean) return { status: "CLEAN", detail: "clamav (http) OK" };
      return { status: "ERROR", detail: "Unexpected scanner response" };
    } catch (e) { return { status: "ERROR", detail: `Scanner unreachable: ${(e as Error).message}` }; }
  }
  if (env.SCANNER !== "clamd" || !env.CLAMD_HOST) return { status: "ERROR", detail: "No malware scanner configured" };
  return new Promise((resolveP) => {
    const sock = new Socket();
    let out = "";
    const done = (r: ScanResult) => { sock.destroy(); resolveP(r); };
    sock.setTimeout(30_000, () => done({ status: "ERROR", detail: "Scanner timeout" }));
    sock.on("error", (e) => done({ status: "ERROR", detail: `Scanner error: ${e.message}` }));
    sock.connect(env.CLAMD_PORT, env.CLAMD_HOST, () => {
      sock.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let i = 0; i < b.length; i += CHUNK) {
        const part = b.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
        sock.write(len); sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on("data", (d) => (out += d.toString()));
    sock.on("end", () => {
      const r = out.replace(/\0/g, "").trim();
      if (/: OK$/.test(r)) done({ status: "CLEAN", detail: "clamd OK" });
      else if (/FOUND$/.test(r)) done({ status: "INFECTED", detail: r.replace(/^stream: /, "") });
      else done({ status: "ERROR", detail: r || "Empty scanner response" });
    });
  });
}
