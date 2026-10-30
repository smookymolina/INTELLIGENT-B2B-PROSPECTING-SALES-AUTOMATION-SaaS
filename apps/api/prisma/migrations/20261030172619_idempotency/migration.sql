-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_ciphertext" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_hash_key" ON "idempotency_keys"("scope", "key_hash");

-- Idempotency (P2-13). RLS enabled with NO policy and NO grant: app_runtime can only use the functions below.
-- Scope is chosen by the server (e.g. 'register' or 'invitations:<org uuid from the verified session>'), never by the client.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION idem_begin(p_scope text, p_key_hash text, p_request_hash text)
RETURNS TABLE (state text, response_ciphertext text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_row public.idempotency_keys%ROWTYPE;
BEGIN
  DELETE FROM public.idempotency_keys WHERE created_at < now() - interval '24 hours';                      -- retention
  DELETE FROM public.idempotency_keys WHERE scope = p_scope AND key_hash = p_key_hash
    AND completed_at IS NULL AND created_at < now() - interval '5 minutes';                                -- abandoned in-flight claim

  INSERT INTO public.idempotency_keys (scope, key_hash, request_hash) VALUES (p_scope, p_key_hash, p_request_hash)
    ON CONFLICT (scope, key_hash) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT 'new'::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.idempotency_keys WHERE scope = p_scope AND key_hash = p_key_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::text;  -- row vanished between statements; client may retry
  ELSIF v_row.request_hash <> p_request_hash THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::text;
  ELSIF v_row.completed_at IS NULL THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::text;
  ELSE
    RETURN QUERY SELECT 'replay'::text, v_row.response_ciphertext;
  END IF;
END $$;

CREATE FUNCTION idem_complete(p_scope text, p_key_hash text, p_ciphertext text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ UPDATE public.idempotency_keys SET response_ciphertext = p_ciphertext, completed_at = now()
      WHERE scope = p_scope AND key_hash = p_key_hash AND completed_at IS NULL $$;

-- Failed commands are not cached: release the claim so the client can retry with the same key.
CREATE FUNCTION idem_release(p_scope text, p_key_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ DELETE FROM public.idempotency_keys WHERE scope = p_scope AND key_hash = p_key_hash AND completed_at IS NULL $$;

REVOKE ALL ON FUNCTION idem_begin(text, text, text), idem_complete(text, text, text), idem_release(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION idem_begin(text, text, text), idem_complete(text, text, text), idem_release(text, text) TO app_runtime;
