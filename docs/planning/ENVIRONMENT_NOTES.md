# Environment notes (cloud container)

The plan was written with Windows paths. In a Linux cloud session, use these instead:

| Plan path | Cloud equivalent |
|---|---|
| `F:\ITSM-Netlink` | `/home/user/Single-Tenant-Netlink-ITSM` (this repo) |
| `F:\Helpdesk - Integration` | Read-only clone: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/dhwajdhruvkar/ticket-management-integration /home/user/reference/ticket-management-integration` (the repo is public). Never edit, commit or push there |

The copy allow-list is in `FEATURE_REUSE_MATRIX.md` §2–§5, and the Phase 0 scope is in `IMPLEMENTATION_ROADMAP.md`. Where the Phase 0 setup commands use PowerShell, run the bash equivalents.

Phase 0 creates `main` from this branch's history (planning docs only), then continues on `phase/00-baseline`.
