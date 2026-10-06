import "server-only";
import { withSystem } from "./db";
import { storage } from "./storage";

/**
 * Hard purge after the 30-day recovery window (spec §36 Deletion). Removes rows and stored objects.
 * Audit rows are retained (append-only, >= 1 year per DPDP Rules Rule 6 as extracted — counsel to confirm), with the chain intact.
 */
const BABY_TABLES = ["medicine_dose", "medicine_schedule", "prescription_item", "medicine", "prescription", "vaccination", "appointment", "allergy", "feeding", "feeding_plan",
  "weight_measurement", "custom_event", "timeline_event", "share_link", "export_job", "baby_schedule_selection", "invitation"];

export async function purgeDue(now = new Date()) {
  return withSystem(async (q) => {
    const due = await q<{ id: string; target_type: string; target_id: string }>(
      "SELECT id, target_type, target_id FROM deletion_request WHERE completed_at IS NULL AND cancelled_at IS NULL AND purge_after <= $1 ORDER BY requested_at", [now]);
    let babies = 0, accounts = 0;
    for (const d of due) {
      if (d.target_type === "BABY") {
        const keys = await q<{ k: string }>("SELECT unnest(array[quarantine_key, vault_key]) AS k FROM medical_document WHERE baby_id = $1", [d.target_id]);
        const exportKeys = await q<{ k: string }>("SELECT storage_key AS k FROM export_job WHERE baby_id = $1 AND storage_key IS NOT NULL", [d.target_id]);
        for (const { k } of [...keys, ...exportKeys]) if (k) await storage().delete(k).catch(() => {});
        await q("UPDATE baby SET photo_document_id = NULL WHERE id = $1", [d.target_id]);
        for (const t of BABY_TABLES) await q(`DELETE FROM ${t} WHERE baby_id = $1`, [d.target_id]);
        await q("DELETE FROM medical_document WHERE baby_id = $1", [d.target_id]);
        await q("DELETE FROM notification WHERE baby_id = $1", [d.target_id]);
        await q("DELETE FROM baby_profile WHERE baby_id = $1", [d.target_id]);
        await q("DELETE FROM baby_membership WHERE baby_id = $1", [d.target_id]);
        await q("DELETE FROM baby_household_index WHERE baby_id = $1", [d.target_id]);
        await q("DELETE FROM baby WHERE id = $1", [d.target_id]);
        babies++;
      } else {
        await q("DELETE FROM push_subscription WHERE user_id = $1", [d.target_id]);
        await q("DELETE FROM notification WHERE user_id = $1", [d.target_id]);
        await q("DELETE FROM user_session WHERE user_id = $1", [d.target_id]);
        await q("DELETE FROM user_password WHERE user_id = $1", [d.target_id]);
        await q("UPDATE baby_membership SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1", [d.target_id]);
        await q("UPDATE household_member SET left_at = coalesce(left_at, now()) WHERE user_id = $1", [d.target_id]);
        await q("DELETE FROM idempotency_key WHERE user_id = $1", [d.target_id]);
        // Pseudonymise the account row (kept only so foreign keys in retained audit rows stay valid)
        await q("UPDATE app_user SET display_name = 'Deleted user', email = 'deleted-' || id::text || '@deleted.invalid', phone_e164 = NULL, settings = '{}', status = 'DELETED' WHERE id = $1", [d.target_id]);
        accounts++;
      }
      await q("UPDATE deletion_request SET completed_at = now() WHERE id = $1", [d.id]);
      await q("SELECT audit_append(NULL, NULL, NULL, NULL, 'PURGE_COMPLETED', 'deletion_request', $1, $2, NULL)", [d.id, JSON.stringify({ target_type: d.target_type })]);
    }
    // housekeeping
    await q("DELETE FROM auth_challenge WHERE created_at < now() - interval '2 days'");
    await q("DELETE FROM rate_limit WHERE window_start < now() - interval '2 days'");
    await q("DELETE FROM idempotency_key WHERE created_at < now() - interval '7 days'");
    const expired = await q<{ storage_key: string }>("UPDATE export_job SET status = 'EXPIRED' WHERE status = 'READY' AND expires_at < now() RETURNING storage_key");
    for (const e of expired) if (e.storage_key) await storage().delete(e.storage_key).catch(() => {});
    const stale = await q<{ quarantine_key: string }>("UPDATE medical_document SET upload_status = 'REJECTED', scan_status = 'REJECTED', scan_detail = 'Upload never completed' WHERE upload_status = 'AWAITING_UPLOAD' AND created_at < now() - interval '1 day' RETURNING quarantine_key");
    for (const s of stale) await storage().delete(s.quarantine_key).catch(() => {});
    return { babies, accounts, expired_exports: expired.length };
  });
}
