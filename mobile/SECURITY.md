# Security policy — 9Drive Mobile

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Use GitHub's private reporting: the repository's **Security → Report a vulnerability** page (maintainers must have
  *Private vulnerability reporting* enabled in the repository settings), or contact the maintainers privately.
- Include: affected version/commit, platform and OS version, steps to reproduce, impact, and any proof of concept.
  Do not include real user data, real tokens or credentials.
- You will get an acknowledgement; a fix timeline depends on severity. Please allow a reasonable time for a fix
  before public disclosure.

## Scope

In scope: the app in `mobile/` (token handling, session logic, app lock, transfers, offline cache, AI client,
sharing, configuration) and the way it uses the backend API. Backend/web issues belong to the main project policy.
Out of scope: attacks that require a rooted/jailbroken device, malware already on the device, social engineering,
volumetric denial of service, third-party service flaws without a defect in how this app uses them.

## What to expect from the app (summary)

Tokens are stored only in the OS keystore; HTTPS is required in release builds; every API response is validated;
no analytics or crash-reporting SDKs are included; logs are redacted. Details and residual risks:
[docs/mobile/05-security-review.md](../docs/mobile/05-security-review.md). This is a self-review, **not** a
penetration test or certification.

## Incident response (for maintainers)

1. **Triage** (within 1 business day): confirm, assign severity (data exposure / account takeover / integrity /
   availability), identify affected versions and whether the backend is involved.
2. **Contain**: if credentials may be exposed, revoke affected sessions server-side (sessions are revocable: the
   backend revokes a whole session on refresh-token reuse; an administrator can revoke others), rotate any leaked
   secret (JWT/encryption keys, provider secrets) and invalidate affected API keys.
3. **Fix**: develop on a private branch, add a regression test (ideally an executable rule like those in
   `src/test/architecture-rules.test.ts`), run the full gate (`npm run check`, `npm run scan:secrets`, bundle export).
4. **Release**: ship a patched build through the stores/TestFlight; if the flaw is server-side, deploy the backend fix
   first. Consider forcing a minimum app version if the API allows it.
5. **Communicate**: notify affected users and the reporter; publish an advisory and changelog entry after the fix is
   available; record what happened and what changed in the security review document.
6. **Learn**: update the threat model and add the missing control/test.
