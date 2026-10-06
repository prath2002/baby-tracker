import "server-only";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { signPayload } from "./crypto";

/**
 * Private object storage (spec §26, §36). Keys are opaque random paths. Two prefixes: quarantine/ and vault/.
 * Signed URLs: single object, short TTL (<= 300 s), response headers pinned.
 */
export interface Storage {
  presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, opts: { ttlSeconds: number; filename: string; contentType: string; disposition: "inline" | "attachment" }): Promise<string>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

const MAX_TTL = 300;

class S3Storage implements Storage {
  c = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
  });
  async presignPut(key: string, contentType: string, contentLength: number, ttl: number) {
    const cmd = new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType, ContentLength: contentLength, ServerSideEncryption: env.S3_ENDPOINT ? undefined : "AES256" });
    const url = await getSignedUrl(this.c, cmd, { expiresIn: Math.min(ttl, MAX_TTL), signableHeaders: new Set(["content-type", "content-length"]) });
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (!env.S3_ENDPOINT) headers["x-amz-server-side-encryption"] = "AES256";
    return { url, headers };
  }
  async presignGet(key: string, o: { ttlSeconds: number; filename: string; contentType: string; disposition: "inline" | "attachment" }) {
    const cmd = new GetObjectCommand({
      Bucket: env.S3_BUCKET, Key: key, ResponseContentType: o.contentType,
      ResponseContentDisposition: `${o.disposition}; filename="${o.filename.replace(/[^\w.\- ]/g, "_")}"`, ResponseCacheControl: "no-store",
    });
    return getSignedUrl(this.c, cmd, { expiresIn: Math.min(o.ttlSeconds, MAX_TTL) });
  }
  async get(key: string) {
    const r = await this.c.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.c.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: env.S3_ENDPOINT ? undefined : "AES256" }));
  }
  async head(key: string) {
    try { const r = await this.c.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key })); return { size: Number(r.ContentLength ?? 0) }; }
    catch { return null; }
  }
  async delete(key: string) { await this.c.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })); }
}

/** Development/test driver: files under LOCAL_STORAGE_DIR, served via HMAC-signed short-lived URLs. Refused in production. */
class LocalStorage implements Storage {
  root = resolve(env.LOCAL_STORAGE_DIR);
  private p(key: string) {
    if (!/^[a-z]+\/[0-9a-f-]+\/[0-9a-f-]+$/i.test(key)) throw new Error("Invalid storage key");
    return join(this.root, key);
  }
  async presignPut(key: string, contentType: string, contentLength: number, ttl: number) {
    const t = signPayload({ k: key, op: "put", ct: contentType, len: contentLength }, Math.min(ttl, MAX_TTL));
    return { url: `${env.APP_URL}/api/files/local?t=${encodeURIComponent(t)}`, headers: { "Content-Type": contentType } };
  }
  async presignGet(key: string, o: { ttlSeconds: number; filename: string; contentType: string; disposition: "inline" | "attachment" }) {
    const t = signPayload({ k: key, op: "get", ct: o.contentType, fn: o.filename, d: o.disposition }, Math.min(o.ttlSeconds, MAX_TTL));
    return `${env.APP_URL}/api/files/local?t=${encodeURIComponent(t)}`;
  }
  async get(key: string) { return readFile(this.p(key)); }
  async put(key: string, body: Buffer) { const f = this.p(key); await mkdir(dirname(f), { recursive: true }); await writeFile(f, body); }
  async head(key: string) { try { return { size: (await stat(this.p(key))).size }; } catch { return null; } }
  async delete(key: string) { try { await unlink(this.p(key)); } catch { /* already gone */ } }
}

let _s: Storage | null = null;
export function storage(): Storage {
  if (_s) return _s;
  _s = env.STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage();
  return _s;
}
