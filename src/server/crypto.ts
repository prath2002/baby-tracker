import "server-only";
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { env } from "./env";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const hmac = (s: string) => createHmac("sha256", env.APP_SECRET).update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const otpCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
export function safeEqualHex(a: string, b: string) {
  const A = Buffer.from(a, "hex"), B = Buffer.from(b, "hex");
  return A.length === B.length && timingSafeEqual(A, B);
}

/** Short-lived HMAC-signed tokens (used for the local storage driver and single-use links). */
export function signPayload(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${hmac("tok:" + body)}`;
}
export function verifyPayload<T = Record<string, unknown>>(token: string): (T & { exp: number }) | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !/^[0-9a-f]{64}$/.test(sig) || !safeEqualHex(sig, hmac("tok:" + body))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp: number };
  if (p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}

/** Password hashing: scrypt (N=2^15, r=8, p=1), stored as scrypt$N$r$p$salt$hash (base64url). */
const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 32 };
function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password.normalize("NFKC"), salt, keyLen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
/** Compared against when no account exists, so a missing email takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomToken()));
