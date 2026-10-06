import "server-only";
import { pool } from "./db";
import { IS_PROD } from "./env";

let checked: Promise<{ rls_enforced: boolean; role: string }> | null = null;
/** Row-level security is bypassed by superusers and BYPASSRLS roles. Refuse to serve in production if so (spec §32). */
export function checkDbRole() {
  checked ??= pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user").then((r) => {
    const row = r.rows[0];
    const ok = !!row && !row.rolsuper && !row.rolbypassrls;
    if (!ok) {
      const msg = `Database role '${row?.rolname}' bypasses row-level security. Connect with a dedicated NOBYPASSRLS application role (see DEPLOY.md).`;
      if (IS_PROD) throw new Error(msg);
      console.warn("[security] " + msg);
    }
    return { rls_enforced: ok, role: row?.rolname ?? "unknown" };
  });
  return checked;
}
