-- Legacy credentials created before provider instances were introduced could
-- have a NULL instance binding. They cannot be safely selected by a pinned
-- run, so revoke them explicitly and prevent new active orphan credentials.
UPDATE provider_credentials
SET status = 'revoked', updated_at = now()
WHERE provider_instance_id IS NULL
  AND status <> 'revoked';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_credentials_instance_required_check'
      AND conrelid = 'provider_credentials'::regclass
  ) THEN
    ALTER TABLE provider_credentials
      ADD CONSTRAINT provider_credentials_instance_required_check
      CHECK (provider_instance_id IS NOT NULL OR status = 'revoked');
  END IF;
END
$$;
