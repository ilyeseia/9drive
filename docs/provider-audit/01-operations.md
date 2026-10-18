# Provider integration — operator notes (audit steps 3–6)

## Schema and migrations

Steps 3–6 changed **no Prisma schema and added no migration**. The lifecycle is expressed in the existing free-string
`connected_accounts.status` column (legacy `unauthorized` = `reauthorization_required`, `pending` =
`pending_authorization`), so the change is code-only and is rolled back by reverting the commits. No production
migration is performed or required. If a later change adds columns (e.g. failure counters), it must be additive and
nullable, with the rollback `ALTER TABLE ... DROP COLUMN`, and deployed only after a backup.

## Behavioural changes to know about before deploying

- A token-refresh outage (timeout, HTTP 429/5xx) no longer marks the account `unauthorized`; the account stays
  `connected`, `last_error` records the reason and clears on the next successful call. Revoked/invalid credentials
  still set `unauthorized`.
- Disconnect now wipes stored tokens/API keys/passwords and overwrites S3 keys with a placeholder; a disconnected
  account must be re-connected with fresh credentials (the same row is revived). Provider-side revocation is **not**
  performed.
- Inline OAuth client credentials create a new `provider_configs` row when the client id differs; existing accounts
  keep the client they were connected with.
- `most_available` routing prefers accounts with known free space; unknown capacity is eligible but never preferred.
- Every response carries `X-Request-Id`; JSON log lines include `requestId` inside a request.
- New: `GET /providers/diagnostics` (authenticated, tenant-scoped, contains no tokens/keys/emails) and
  `limit`/`offset` on `GET /providers` (max 500).

## Read-only checks to run before/after deploying (PostgreSQL)

Orphan half-finished OAuth connections (safe to delete once older than the OAuth state lifetime; the app also sweeps
them):

```sql
SELECT id, user_id, provider, created_at FROM connected_accounts
WHERE status = 'pending' AND provider_account_id LIKE 'pending:%' AND created_at < now() - interval '15 minutes';
```

Possible duplicate TeraBox (cookie) accounts for one user and login email — review by hand, do not auto-merge
(files reference `connected_account_id`):

```sql
SELECT user_id, lower(email) AS login, count(*) AS accounts, array_agg(id) AS ids
FROM connected_accounts
WHERE provider = 'terabox' AND status <> 'disconnected'
GROUP BY user_id, lower(email) HAVING count(*) > 1;
```

## Credential encryption key

Credentials are AES-256-GCM encrypted with a key derived from `TOKEN_ENCRYPTION_KEY`. Since Step 4 a stored value that
cannot be decrypted raises `ERR_INTERNAL` instead of silently looking like a missing token, so a wrong or rotated key
is visible immediately. Changing `TOKEN_ENCRYPTION_KEY` makes existing credentials
unreadable until they are re-encrypted. Use the bundled tool (provider configs, connected-account tokens, S3 keys,
webhook secrets; `v1:` prefix preserved; idempotent and resumable; dry run by default):

```bash
OLD_TOKEN_ENCRYPTION_KEY=<old> NEW_TOKEN_ENCRYPTION_KEY=<new> npm run credentials:reencrypt
OLD_TOKEN_ENCRYPTION_KEY=<old> NEW_TOKEN_ENCRYPTION_KEY=<new> npm run credentials:reencrypt -- --apply
```

Procedure: back up the database; run the dry run and require `totalUndecryptable: 0`; stop the backend and worker; run
with `--apply`; switch `TOKEN_ENCRYPTION_KEY` to the new value; start; verify with `GET /providers/diagnostics`. Keys are
read from the environment only and never printed. Tested against a real database (dry run writes nothing, apply is
idempotent, rollback by swapping the keys); it has **not** been run against a production-sized dataset, and other
tables that may hold secrets in free-form JSON (`metadata`) are not covered.

## Known limits (not changed)

- Concurrent token refreshes are de-duplicated inside one backend process and protected across processes by
  compare-and-set writes; two processes may still each call the token endpoint once.
- If the database write fails after a successful remote upload, a best-effort permanent delete of the remote object is attempted (logged as `database write failed after remote upload`); if that delete also fails the object stays behind and only the log shows it.
- No automatic fall-back to a second account when the chosen provider fails an upload.
- Real Google, TeraBox and S3 endpoints were not exercised (no credentials available).
