# TeraBox troubleshooting

Applies to the official provider `terabox_open`. Errors shown to users are normalised;
raw provider detail is kept server-side (credential fields are redacted) and never sent
to the browser. Reproduce with `docs/terabox-integration.md` §10.

## Connecting

| Symptom | Likely cause | Action |
|---|---|---|
| `409 PROVIDER_NOT_CONFIGURED` when showing the QR | `TERABOX_CLIENT_ID/SECRET` not seeded or `TERABOX_PRIVATE_SECRET` missing | Set all three, run `npm run seed:terabox-config` (or recreate the `migrate` service). The app itself keeps working. |
| QR start fails (backend log `[terabox_open] device start failed: ERR_INTERNAL - TeraBox rejected the application credentials`, TeraBox errno `100001`) | Wrong `client_id`/`client_secret`, or the `sign` is wrong (a wrong `private_secret` is reported the same way) | Re-check the three values against your approved app. The `sign` format is `md5(client_id_timestamp_client_secret_private_secret)` – lowercase hex is assumed *(unverified)*. |
| QR shown but never completes | Not scanned/approved, QR expired (≈5 min), or TeraBox app login blocked in your region | Start again; the document notes a VPN may be needed to log in to the TeraBox app. |
| `404 DEVICE_FLOW_NOT_FOUND` | Handle expired, already used, or belongs to a different 9Drive user | Start again. |
| `429` while polling | The per-user rate limit (240 polls/5 min) or TeraBox errno `300001` was hit. Polls sent faster than TeraBox's interval are answered `pending` without contacting TeraBox | The UI backs off automatically; wait and retry. |
| `502 ACCOUNT_PROFILE_FAILED` | Authorized, but `/oauth/tokeninfo` or the profile call failed (e.g. domain outside `terabox.com`) | Check backend logs for `ERR_SSRF_BLOCKED`/`ERR_UPSTREAM_UNAVAILABLE`. |

## Account shows `unauthorized` / `Provider credentials expired`

Causes, most likely first:

1. Refresh token older than 30 days (account idle) or already used (errno `200004`/`200005`).
2. A refresh race between processes consumed the single-use token and no fresh pair was stored.
3. `TERABOX_PRIVATE_SECRET` removed or changed (refresh then fails before contacting TeraBox).
4. The user revoked the app inside TeraBox.

Fix: *Providers → Connect TeraBox* and scan again; the same account is **reauthorized in
place** (routing flag and file history are preserved). Use *Health* to re-test.

## Uploads

| Symptom | Likely cause | Action |
|---|---|---|
| `NO_ACCOUNT_WITH_ENOUGH_SPACE: quota is unknown / stale` | No recent quota reading for TeraBox accounts | Press *Sync* on the account; check that quota calls succeed. |
| `…routing is disabled for this account` | Routing switch is Off | Turn *Routing* On, or upload with the account pinned. |
| `CAPABILITY_UNSUPPORTED` | Operation needs `createFolder`/sharing/resume/range, which TeraBox's documented API lacks | Not available; choose another provider for that operation. |
| `VALIDATION_FAILED` on upload | Zero-byte file, invalid name, or the remote folder does not exist | TeraBox flow rejects empty files; create folders in TeraBox (folder creation is not exposed). |
| Upload fails with a size mismatch | Declared size ≠ bytes streamed | Client bug or truncated transfer; retry the whole upload. |
| File appears as `name(1).ext` | A same-named file existed (`rtype=1` renames instead of overwriting) | Expected; the new path is stored as the file's remote id. |
| Disk fills in `UPLOAD_SPOOL_DIR` | Many large concurrent uploads (each is staged to disk) | Lower `TERABOX_UPLOAD_CONCURRENCY`; enlarge the spool volume. Orphaned `9drive-tb-*` dirs only appear if the process was killed mid-upload and can be deleted when no upload is running. |
| Duplicate after a timeout | `create` is not auto-retried; if the response was lost the file may exist | Check the folder before re-uploading. |

## Downloads

- `ERR_SSRF_BLOCKED` / "outside terabox.com": TeraBox returned a download or CDN host
  outside `terabox.com` (or http). Hosts are validated strictly; if the live service
  uses another official domain, extend `isTeraBoxHostname()` in
  `providers/terabox-open/transport.ts` after confirming it with TeraBox *(unverified)*.
- `UNAUTHENTICATED` on the CDN request: the access token expired between lookup and
  download; retry (a fresh token is obtained automatically).

## Wrong folder / "not found"

If everything lists empty or `ERR_NOT_FOUND`, `TERABOX_APP_ROOT` is probably wrong or
unset when TeraBox expects the application-folder prefix. The official text is
inconsistent about the folder name *(unverified)*; set it to what your approved app uses.

## Useful checks

```bash
cd backend
npx vitest run src/__tests__/providers/terabox-open      # adapter behaviour vs the documented contract
npm run seed:terabox-config                              # re-seed app credentials
```

Server logs (`provider.context`) include account id and provider only; access tokens,
refresh tokens, `private_secret`, device codes and request URLs (the token travels in
the URL query per TeraBox's design) are never logged.

## Disabling TeraBox

Remove `TERABOX_*` from the environment and redeploy. Existing TeraBox accounts become
`unauthorized` when their tokens next need refreshing (restore the variables to recover
while the refresh token is still valid). Google Drive, S3 and other providers are
unaffected.
