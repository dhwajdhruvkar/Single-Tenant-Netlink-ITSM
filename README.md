# Netlink ITSM

Single-company IT service management application (Next.js, TypeScript, Postgres, Microsoft Entra sign-in).

Planning package: [`docs/planning/`](docs/planning/00_README_HANDOFF.md). Implementation proceeds in phases; see
`docs/planning/IMPLEMENTATION_ROADMAP.md`.

## Local development

Requirements: Node 22 (`.nvmrc`), Docker.

```bash
cp .env.example .env.local     # placeholders only; never commit populated env files
docker compose up -d postgres  # local Postgres (databases itsm_dev and itsm_test)
npm install
npm run dev
```

Checks: `npm run typecheck && npm run lint && npm test`. `npm run test:integration` is used from Phase 2 onward and
must only target local Docker Postgres.

There is intentionally no `db:push` or `db:reset` script.

> npm note: with npm 10.9 the `vitest@4.1.11` peer set crashes the resolver (`Cannot read properties of null
> (reading 'edgesOut')`). The lockfile was generated with npm 11; `npm ci` works with the bundled npm 10.

## Repository settings (owner action)

Enable branch protection on `main`: require a pull request, require the CI check, disallow force pushes.
