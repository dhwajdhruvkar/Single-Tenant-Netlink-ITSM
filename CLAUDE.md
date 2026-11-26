# Netlink ITSM — working rules

Single-company ITSM. Plan: `docs/planning/` (start at `00_README_HANDOFF.md`; phases in `IMPLEMENTATION_ROADMAP.md`).

## Workflow
- One phase at a time, branch `phase/<nn>-<slug>` from an up-to-date `main`, PR to `main`, then stop for review.
- Before a PR run `npm run typecheck && npm run lint && npm test` (plus `npm run test:integration` from Phase 2, local Docker Postgres only). Report real results only.
- Implement `[OPEN]`/`[EXTERNAL]` items as documented defaults behind configuration and list them in the PR. Do not invent company workflow.

## Hard prohibitions
- Never run `prisma migrate reset`, `prisma db push`, `DROP`, `TRUNCATE` or destructive SQL against any Neon database.
- Never touch Neon project `wild-mouse-14431497` (`netlink-support`) or the original Vercel project.
- `ticket-management-integration` / `F:\Helpdesk - Integration` are read-only references; copy only via the allow-list in `FEATURE_REUSE_MATRIX.md` §2–§5.
- Never commit secrets or populated `.env` files.
- No demo, local-password or self-registration sign-in.
- Never trust requester identity or roles from the browser; `Employee.entraObjectId` is the identity key, never email.
- Phases 12 and 13 need the owner's explicit written approval before any cloud resource is created; destructive DB steps need a second confirmation naming project, branch and database.
