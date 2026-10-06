import "server-only";
import { uuidv7 } from "@/lib/ids";
import { withSystem } from "../db";
import { IS_PROD } from "../env";
import { randomToken, sha256 } from "../crypto";

export const SESSION_COOKIE = IS_PROD ? "__Host-bh_session" : "bh_session";
const IDLE_MS = 14 * 24 * 3600_000;      // idle timeout
const ABSOLUTE_MS = 60 * 24 * 3600_000;  // absolute lifetime
const ROTATE_MS = 24 * 3600_000;         // rotate token daily
const ROTATION_GRACE_MS = 60_000;        // concurrent requests carrying the previous token
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export type SessionInfo = {
  sessionId: string;
  userId: string;
  registrationComplete: boolean;
  stepUpAt: Date | null;
  displayName: string;
};

export function sessionCookie(token: string, maxAgeMs = ABSOLUTE_MS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${IS_PROD ? "; Secure" : ""}`;
}
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? "; Secure" : ""}`;

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null; deviceName?: string | null }) {
  const token = randomToken();
  const id = uuidv7();
  await withSystem((q) => q(
    `INSERT INTO user_session(id, user_id, token_hash, device_name, user_agent, ip, expires_at, step_up_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '60 days', now())`,
    [id, userId, sha256(token), meta.deviceName ?? null, meta.userAgent?.slice(0, 300) ?? null, meta.ip],
  ));
  return { token, id };
}

/** Resolves and maintains the session for a request (idle/absolute expiry, rotation with reuse detection). */
export async function getSessionFromRequest(req: Request, setCookies: string[]): Promise<SessionInfo | null> {
  const token = readCookie(req, SESSION_COOKIE) ?? bearer(req);
  if (!token || token.length > 100) return null;
  const h = sha256(token);
  return withSystem(async (q) => {
    const s = await q.one<{
      id: string; user_id: string; token_hash: string; prev_token_hash: string | null; last_seen_at: Date; rotated_at: Date;
      expires_at: Date; revoked_at: Date | null; step_up_at: Date | null; guardian_attested_at: Date | null; status: string; display_name: string;
    }>(
      `SELECT s.*, u.guardian_attested_at, u.status, u.display_name FROM user_session s JOIN app_user u ON u.id = s.user_id
       WHERE s.token_hash = $1 OR s.prev_token_hash = $1 LIMIT 1`, [h]);
    if (!s || s.revoked_at || s.status !== "ACTIVE") return null;
    const now = Date.now();
    if (s.token_hash !== h) {
      // previous token presented
      if (now - s.rotated_at.getTime() > ROTATION_GRACE_MS) {
        await q("UPDATE user_session SET revoked_at = now(), revoked_reason = 'TOKEN_REUSE' WHERE id = $1", [s.id]);
        await q("SELECT audit_append(NULL, NULL, $1, NULL, 'SESSION_TOKEN_REUSE_DETECTED', 'user_session', $2, NULL, NULL)", [s.id, s.id]);
        return null;
      }
    }
    if (now - s.last_seen_at.getTime() > IDLE_MS || s.expires_at.getTime() < now) {
      await q("UPDATE user_session SET revoked_at = now(), revoked_reason = 'EXPIRED' WHERE id = $1 AND revoked_at IS NULL", [s.id]);
      return null;
    }
    if (s.token_hash === h && now - s.rotated_at.getTime() > ROTATE_MS) {
      const fresh = randomToken();
      await q("UPDATE user_session SET prev_token_hash = token_hash, token_hash = $2, rotated_at = now(), last_seen_at = now() WHERE id = $1", [s.id, sha256(fresh)]);
      setCookies.push(sessionCookie(fresh, s.expires_at.getTime() - now));
    } else if (now - s.last_seen_at.getTime() > 60_000) {
      await q("UPDATE user_session SET last_seen_at = now() WHERE id = $1", [s.id]);
    }
    const consent = await q.one("SELECT 1 FROM consent_record WHERE user_id = $1 AND purpose = 'CORE_PROCESSING' AND granted ORDER BY recorded_at DESC LIMIT 1", [s.user_id]);
    return {
      sessionId: s.id, userId: s.user_id, stepUpAt: s.step_up_at, displayName: s.display_name,
      registrationComplete: !!s.guardian_attested_at && !!consent,
    };
  });
}

function bearer(req: Request) {
  const a = req.headers.get("authorization");
  return a?.startsWith("Bearer ") ? a.slice(7).trim() : null;
}

export function hasRecentStepUp(s: SessionInfo) {
  return !!s.stepUpAt && Date.now() - new Date(s.stepUpAt).getTime() < STEP_UP_WINDOW_MS;
}
