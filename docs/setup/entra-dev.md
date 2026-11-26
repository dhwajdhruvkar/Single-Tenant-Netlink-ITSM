# Entra dev app registration (company IT performs this) [EXTERNAL]

From `docs/planning/INFRASTRUCTURE_AND_DEPLOYMENT.md` section 3.1. Placeholders only; never commit secrets.

- Name `Netlink ITSM – Dev`, **single tenant**.
- Web redirect URI: `http://localhost:3000/api/auth/callback/microsoft-entra-id`. Implicit grant off; public client flows off.
- Delegated permissions: `openid`, `profile`, `email`, `User.Read`.
- ID token must carry `oid`, `tid`, `preferred_username`, `email` (optional claim) and `roles`.
- App roles: `ITSM.Agent`, `ITSM.Manager`, `ITSM.Admin`, optional `ITSM.Submitter`. Assign test users (one per role).
- Enterprise app: "Assignment required" = Yes is recommended.

Local `.env.local`:
```
ENTRA_TENANT_ID=<tenant guid>
ENTRA_CLIENT_ID=<app guid>
ENTRA_CLIENT_SECRET=<secret>
AUTH_SECRET=<random, 32+ chars>
```
