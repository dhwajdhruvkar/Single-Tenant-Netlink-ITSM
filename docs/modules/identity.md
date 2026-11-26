# Identity and authentication (Phase 3)

Single-tenant Microsoft Entra OIDC via Auth.js (`next-auth@5.0.0-beta.32`). **There is no Credentials provider, demo mode,
local password or self-registration anywhere.**

## Flow
1. Entra ID token → `signIn` callback (`src/auth.ts`) → `readEntraClaims` requires `tid == ENTRA_TENANT_ID` and a GUID `oid`
   (the pairwise `sub` is never used as identity).
2. `handleSignIn` (`src/modules/identity/signInService.ts`), in one transaction: upsert `Employee` by `entraObjectId`, deny if
   directory-removed / disabled / ineligible, upsert `UserAccount` (deny if admin-disabled), replace Entra-sourced roles (manual
   grants preserved), effective role = highest, audit `auth.signin` / `auth.signin_denied`.
3. The JWT holds only `{uaid, eid, sv}`. `session.maxAge = SESSION_MAX_AGE_HOURS` (default 8 [OPEN]), `updateAge = 1h`.
4. Every API call goes through `requireActor(permission?)` (`src/platform/http/requireActor.ts`), which re-reads the account:
   active, `sessionVersion` matches, employee still enabled/eligible/not removed. Role and groups come from the database each time,
   never from the token or request. Disabling an account or bumping `sessionVersion` is a 401 on the next call.
5. `src/proxy.ts` (edge-safe) only checks that a session exists: pages → `/signin`, `/api/*` → JSON 401.

## Roles
Entra app roles (`ITSM.Agent|Manager|Admin|Submitter`, values configurable via `ENTRA_ROLE_*`) → `agent|manager|admin|submitter`;
default `employee`. Roles are a hierarchy (employee < submitter < agent < manager < admin). Permissions:
`src/modules/identity/permissions.ts`; record-level visibility: `policies.ts` (`canViewTicket`, `canViewInternal`).

## Deliberate decisions / deviations
- **`ticket.confirm_reopen` for submitters:** Doc C shows "—", but with a role hierarchy a submitter keeps the employee right to
  confirm/reopen their *own* tickets. Record-level rules still apply.
- **`ticket.view.all` for agents** is [OPEN]; default off, enable with `AGENTS_VIEW_ALL_TICKETS=true`.
- **`config.group_membership`** is admin-only by default ([OPEN]: managers).
- **Profile photo:** the stock Entra provider downloads a photo from Graph; we override `profile()` so no photo is fetched or stored.
- **Session ids in the browser:** `/api/auth/session` exposes `{uaid, eid, sv}` (ids only). Authorisation never trusts them beyond
  looking up the account.
- **CSRF:** `withApi` rejects cross-site mutating requests (`Sec-Fetch-Site`/`Origin`). Bearer-secret endpoints opt out with
  `{ csrf: false }`. Unit-tested; not exercised through a real browser.
- **Redirects:** post-login destinations are reduced to a local path (`safeRedirectPath`).
- **`Cache-Control: no-store`** on all non-static responses.

## Verification status
Verified here: unit and integration tests (see PR/commit), and runtime checks on the production build with sessions minted using
the real secret: no session → 401/redirect; valid → 200; tampered / wrong-secret → 401; role in JWT ignored; `sessionVersion`
bump, disabled account and directory-disabled employee → 401 on the next call; role change in DB visible without re-login.
**NOT verified: any real Entra sign-in** (no dev app registration exists yet [EXTERNAL]). See `docs/testing/entra-checklist.md`.
