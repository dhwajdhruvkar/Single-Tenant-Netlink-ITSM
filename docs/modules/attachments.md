# Attachments and storage (Phase 6)

## Flow
1. `POST /api/attachments` (multipart, one `file`) validates and stores the bytes and records an `Attachment` row as **`staged`**.
   Permission `ticket.create.self`; 30 uploads/min/user. Oversized bodies are refused from `Content-Length` before being read.
2. The ticket form sends the staged ids as `attachmentIds`. `createTicket` links them **inside the creation transaction**
   (`linkStagedAttachments`): only `staged` rows uploaded by the same actor in the last 24 h, at most 10, no duplicates. Anything else is
   one uniform 422 `ATTACHMENT_INVALID` (it does not reveal whether an id exists or whose it is) and rolls the ticket back too. The link is a
   conditional update, so two requests cannot claim the same file.
3. `GET /api/attachments/{id}` streams it. `DELETE` soft-deletes (uploader while staged; agent+ who can see the ticket).

## Port and providers
`ObjectStorage { put, get, delete, exists }` (`modules/attachments/ports.ts`); a `MalwareScanner` port (default no-op ⇒ `not_scanned`).
- `database` — bytes in `StoredObject` (same Postgres). **Temporary**, capped at 4 MB/file (also the cap on Vercel).
- `local` — disk, **development only** (throws when `NODE_ENV=production`).
- `s3`, `azure_blob` — **not implemented**: `UnavailableStorage` fails loudly (503). They need to pass the same provider contract suite
  (`tests/integration/storageProviders.test.ts`) against MinIO/Azurite before being enabled; that has not been possible here.
Keys: `itsm/{local|staging|production}/att/{yyyy}/{mm}/{uuid}`, validated by regex on every operation (no traversal). `APP_ENV=test` uses `local`.

## Validation (`validation.ts`)
Allow-list of types; blocked extensions (exe, dll, bat, cmd, com, scr, ps1, vbs, js, jar, msi, sh, apk, hta, lnk, …) checked on **every**
dot-segment (so `invoice.exe.pdf` is refused); executables refused by magic bytes whatever the name (MZ, ELF, Mach-O, `#!`); declared
type, extension and content must agree (PNG/JPEG/GIF/WebP/BMP/HEIC, PDF, ZIP/OOXML, legacy Office/MSG, MP4, SVG); `application/octet-stream`
only for known-safe extensions. File names: NFC, directories stripped, control/bidi-override characters removed, unsafe characters → `_`,
no leading dots, ≤ 140 chars keeping the extension. Content types are never taken from the client beyond the allow-list.

## Download rules
404 (never 403) unless: staged ⇒ uploader only; linked ⇒ `canViewTicket`; on an **internal** message ⇒ also `canViewInternal`; archived
ticket / deleted file / missing object ⇒ 404; infected ⇒ 404. `[OPEN]` `ATTACHMENT_REQUIRE_CLEAN_SCAN=true` ⇒ 409 unless `clean`.
Headers: `Content-Disposition: attachment` (ASCII + RFC 5987 name, injection-safe), `X-Content-Type-Options: nosniff`,
`Cache-Control: private, no-store`, `Content-Security-Policy: default-src 'none'; sandbox`. Each successful download writes an
`attachment.download` audit row. The ticket view lists only the files the viewer may see (internal-message files are excluded in the query).

## Cleanup (`cleanupAttachments`, to be scheduled by the Phase 8 runner as `attachments.cleanup`)
Deletes staged uploads older than 24 h (object + row) and purges the bytes of attachments soft-deleted more than 30 days ago ([OPEN])
while keeping their metadata row. A storage failure keeps the row so the next run retries; purged rows are not reprocessed.

## Rollback switch
`ATTACHMENTS_ENABLED=false`: the UI controls are not rendered and uploads/downloads return 503.

## Verified / not verified
Verified: unit (validation tables, keys, headers), provider contract suite on database + local disk incl. persistence across a new client,
service tests (authorization matrix, linking, atomic create, cleanup), component tests, and the HTTP flow on the production build (valid
upload; EXE, PNG-renamed-PDF, EXE-as-txt and >4 MB rejected; other user's id refused with no ticket created; requester/agent allowed,
others 404; headers; bytes identical; kill switch).
**Not verified:** S3/Azure (not implemented), any malware scanner (none available [EXTERNAL]), the Vercel 4.5 MB body limit (the 4 MB cap
is a safety margin, never tested on Vercel), large-volume storage in Postgres, real-browser uploads.
Message attachments (`messageId`) are supported by the service and schema; the message API that uses them is Phase 7.
