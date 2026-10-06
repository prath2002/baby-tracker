-- 003_functions.sql — audit hash chain append and rate limiting helpers.

-- Appends an audit row, chaining sha256(prev_hash || canonical row text) per chain_key.
-- SECURITY DEFINER + temporary system flag so that any actor can append without being able to read others' rows.
CREATE OR REPLACE FUNCTION audit_append(
  p_actor uuid, p_ip inet, p_session uuid, p_baby uuid, p_action text,
  p_entity_table text, p_entity_id text, p_detail jsonb, p_request_id text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev_system text := coalesce(current_setting('app.system', true), '');
  v_chain text := coalesce(p_baby::text, 'user:' || coalesce(p_actor::text, 'system'));
  v_prev char(64);
  v_now timestamptz := clock_timestamp();
  v_hash char(64);
  v_id bigint;
BEGIN
  IF p_actor IS DISTINCT FROM app_uid() AND NOT app_is_system() THEN
    RAISE EXCEPTION 'audit actor mismatch';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || v_chain));
  PERFORM set_config('app.system', 'on', true);
  SELECT row_hash INTO v_prev FROM audit_log WHERE chain_key = v_chain ORDER BY id DESC LIMIT 1;
  v_hash := encode(sha256(convert_to(
      coalesce(v_prev, '') || '|' || v_now::text || '|' || coalesce(p_actor::text, '') || '|' || coalesce(p_baby::text, '') || '|' ||
      p_action || '|' || coalesce(p_entity_table, '') || '|' || coalesce(p_entity_id, '') || '|' || coalesce(p_detail::text, ''), 'UTF8')), 'hex');
  INSERT INTO audit_log(occurred_at, actor_user_id, actor_ip, session_id, baby_id, action, entity_table, entity_id, detail, request_id, chain_key, prev_hash, row_hash)
  VALUES (v_now, p_actor, p_ip, p_session, p_baby, p_action, p_entity_table, p_entity_id, p_detail, p_request_id, v_chain, v_prev, v_hash)
  RETURNING id INTO v_id;
  PERFORM set_config('app.system', v_prev_system, true);
  RETURN v_id;
END $$;

-- Verifies a chain; returns the first broken id or NULL when intact.
CREATE OR REPLACE FUNCTION audit_verify_chain(p_chain text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_prev char(64) := NULL; v_calc char(64); v_prev_system text := coalesce(current_setting('app.system', true), '');
BEGIN
  PERFORM set_config('app.system', 'on', true);
  FOR r IN SELECT * FROM audit_log WHERE chain_key = p_chain ORDER BY id LOOP
    v_calc := encode(sha256(convert_to(
      coalesce(v_prev, '') || '|' || r.occurred_at::text || '|' || coalesce(r.actor_user_id::text, '') || '|' || coalesce(r.baby_id::text, '') || '|' ||
      r.action || '|' || coalesce(r.entity_table, '') || '|' || coalesce(r.entity_id, '') || '|' || coalesce(r.detail::text, ''), 'UTF8')), 'hex');
    IF v_calc <> r.row_hash OR coalesce(r.prev_hash, '') <> coalesce(v_prev, '') THEN
      PERFORM set_config('app.system', v_prev_system, true);
      RETURN r.id;
    END IF;
    v_prev := r.row_hash;
  END LOOP;
  PERFORM set_config('app.system', v_prev_system, true);
  RETURN NULL;
END $$;

-- Fixed-window rate limiter. Returns true when the call is allowed.
CREATE OR REPLACE FUNCTION rate_hit(p_bucket text, p_window_seconds int, p_limit int) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_start timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds); v_count int;
BEGIN
  INSERT INTO rate_limit(bucket, window_start, count) VALUES (p_bucket, v_start, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit.count + 1
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END $$;
