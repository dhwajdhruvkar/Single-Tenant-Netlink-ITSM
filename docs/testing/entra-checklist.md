# Entra manual checklist (staging / dev, real test accounts — one per role)

Not yet performed: no Entra registration exists. Tick each item with date and tester when run.

1. Employee with no special role signs in. `/desk` shows a 403 page (Phase 7 UI).
2. Agent, manager and admin each see their navigation; API calls permitted only per the permission matrix.
3. A user not assigned to the enterprise app (assignment required) is blocked by Entra.
4. A guest user from another tenant is denied (AADSTS or the app's `tid` check → `/access-denied`).
5. Remove a role in Entra → after re-sign-in the role is gone.
6. Disable the user in Entra → new sign-in blocked; after the directory sync (Phase 4) the existing session gets 401.
7. MFA / Conditional Access prompts appear per company policy (observed, not implemented by the app).
8. Sign-out clears the session; the back button does not reveal data (`Cache-Control: no-store`).
9. Form B shows correct directory data for the signed-in user (Phase 5/4). Form A search finds a newly added Entra user.
10. Mailbox scope: sending as a non-support mailbox through the daemon app fails (Phase 9).
11. Check `AuditLog` has `auth.signin`, `auth.signin_denied` (with reason) and `auth.signout` rows.
12. Confirm the ID token really contains `oid`, `tid`, `roles`, `preferred_username`.
