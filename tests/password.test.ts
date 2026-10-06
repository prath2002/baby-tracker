import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, login, raw } from "./helpers";
import { pool, withUser, withSystem } from "@/server/db";

const PW = "correct horse battery";
const cookieOf = (r: { headers: Headers }) => r.headers.get("set-cookie")?.split(";")[0] ?? null;

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("email + password auth", () => {
  let userId: string;

  it("registers, signs in, and starts unregistered", async () => {
    const r = await raw("POST", "/auth/password/register", { email: "Pat@Example.in", password: PW });
    expect([200, 201]).toContain(r.status);
    expect(r.body.new_user).toBe(true);
    expect(r.body.registration_complete).toBe(false);
    userId = r.body.user_id;
    const me = await raw("GET", "/me", undefined, { cookie: cookieOf(r)! });
    expect(me.body.email).toBe("pat@example.in");
    expect(me.body.has_password).toBe(true);
  });

  it("rejects short passwords and duplicate emails", async () => {
    expect((await raw("POST", "/auth/password/register", { email: "short@example.in", password: "123456789" })).status).toBe(400);
    const dup = await raw("POST", "/auth/password/register", { email: "pat@example.in", password: PW });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("ACCOUNT_EXISTS");
  });

  it("signs in with the right password only, with the same error for unknown emails", async () => {
    const ok = await raw("POST", "/auth/password/login", { email: "PAT@example.in", password: PW });
    expect([200, 201]).toContain(ok.status);
    expect(ok.body.user_id).toBe(userId);
    expect(cookieOf(ok)).toBeTruthy();
    const wrong = await raw("POST", "/auth/password/login", { email: "pat@example.in", password: PW + "x" });
    const unknown = await raw("POST", "/auth/password/login", { email: "nobody@example.in", password: PW });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("CREDENTIALS_INCORRECT");
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("CREDENTIALS_INCORRECT");
    expect(cookieOf(wrong)).toBeNull();
  });

  it("does not let a password sign into a code-only account", async () => {
    await login("codeonly@example.in");
    const r = await raw("POST", "/auth/password/login", { email: "codeonly@example.in", password: PW });
    expect(r.body.code).toBe("CREDENTIALS_INCORRECT");
    expect((await raw("POST", "/auth/password/register", { email: "codeonly@example.in", password: PW })).status).toBe(409);
  });

  it("step-up accepts the account password", async () => {
    const s = await raw("POST", "/auth/password/login", { email: "pat@example.in", password: PW });
    const cookie = cookieOf(s)!;
    expect((await raw("POST", "/auth/password/step-up", { password: "nope" }, { cookie })).status).toBe(400);
    const ok = await raw("POST", "/auth/password/step-up", { password: PW }, { cookie });
    expect(ok.body.step_up).toBe(true);
  });

  it("password hashes are invisible to user-scoped queries", async () => {
    const rows = await withUser(userId, (q) => q("SELECT * FROM user_password"));
    expect(rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM user_password")).rows).toHaveLength(0);
    const stored = await withSystem((q) => q.one<{ password_hash: string }>("SELECT password_hash FROM user_password WHERE user_id = $1", [userId]));
    expect(stored!.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(stored!.password_hash).not.toContain(PW);
  });
});
