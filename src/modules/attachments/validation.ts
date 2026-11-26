import { createHash } from "node:crypto";
import { AppError, ValidationError } from "@/platform/errors";

// Upload validation. Adapted from the reference implementation (allow-list, blocked extensions, image magic bytes) and extended:
// PDF/Office/ZIP signatures, executable-content detection regardless of name, and stricter file-name sanitising.

export const MAX_FILES_PER_TICKET = 10;

const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/heic", "image/svg+xml",
  "application/pdf", "text/plain", "text/csv", "text/markdown", "application/json",
  "application/zip", "application/x-zip-compressed", "message/rfc822", "application/vnd.ms-outlook",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "video/mp4", "application/octet-stream",
]);

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse", "jar", "msi", "sh", "apk", "hta", "lnk", "reg", "wsf",
  "msc", "pif", "cpl", "app", "dmg", "iso", "bin", "scf", "inf",
]);

/** Extensions accepted when the browser sends no useful type (application/octet-stream). */
const OCTET_STREAM_OK = new Set([
  "txt", "log", "csv", "md", "json", "eml", "msg", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "mp4",
]);

type Family = "png" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "pdf" | "zip" | "ole" | "mp4";

const EXT_FAMILY: Record<string, Family> = {
  png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", bmp: "bmp", heic: "heic", pdf: "pdf",
  zip: "zip", docx: "zip", xlsx: "zip", pptx: "zip", doc: "ole", xls: "ole", ppt: "ole", msg: "ole", mp4: "mp4",
};
const MIME_FAMILY: Record<string, Family> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/heic": "heic",
  "image/heif": "heic", "application/pdf": "pdf", "application/zip": "zip", "application/x-zip-compressed": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "zip",
  "application/msword": "ole", "application/vnd.ms-excel": "ole", "application/vnd.ms-powerpoint": "ole", "application/vnd.ms-outlook": "ole", "video/mp4": "mp4",
};

// Characters that can disguise a file name: C0/C1 controls and bidirectional overrides (e.g. "invoice‮fdp.exe" displays as "invoiceexe.pdf").
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

export function sanitizeFileName(name: string): string {
  const base = (name.normalize("NFC").split(/[\\/]/).pop() ?? "").replace(HIDDEN_CHARS, "");
  let cleaned = base.replace(/[^\p{L}\p{N}._\-()[\] ]+/gu, "_").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^\.+/, "").replace(/[. ]+$/, ""); // no hidden files, no trailing dot/space (Windows)
  if (cleaned.length > 140) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 140 - ext.length) + ext;
  }
  return cleaned || "file";
}

function extensionsOf(fileName: string): string[] {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.slice(1) : [];
}

function startsWith(b: Uint8Array, ...bytes: number[]): boolean {
  return bytes.every((v, i) => b[i] === v);
}
function ascii(b: Uint8Array, offset: number, s: string): boolean {
  return [...s].every((c, i) => b[offset + i] === c.charCodeAt(0));
}

export function sniffFamily(b: Uint8Array): Family | null {
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(b, 0xff, 0xd8, 0xff)) return "jpeg";
  if (startsWith(b, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  if (startsWith(b, 0x42, 0x4d)) return "bmp";
  if (ascii(b, 4, "ftyp")) return ascii(b, 8, "heic") || ascii(b, 8, "heix") || ascii(b, 8, "mif1") ? "heic" : "mp4";
  if (startsWith(b, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "pdf"; // %PDF-
  if (startsWith(b, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "ole";
  return null;
}

/** Executables and scripts are refused whatever the file is called. */
export function looksExecutable(b: Uint8Array): boolean {
  return (
    startsWith(b, 0x4d, 0x5a) || // MZ: Windows PE (.exe/.dll)
    startsWith(b, 0x7f, 0x45, 0x4c, 0x46) || // ELF
    startsWith(b, 0xfe, 0xed, 0xfa, 0xce) || startsWith(b, 0xfe, 0xed, 0xfa, 0xcf) || startsWith(b, 0xce, 0xfa, 0xed, 0xfe) || startsWith(b, 0xcf, 0xfa, 0xed, 0xfe) || // Mach-O
    startsWith(b, 0xca, 0xfe, 0xba, 0xbe) || // Java class / universal binary
    startsWith(b, 0x23, 0x21) // "#!" script
  );
}

export interface UploadInput {
  fileName: string;
  declaredType: string;
  bytes: Buffer;
}

export interface ValidatedUpload {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export function validateUpload(input: UploadInput, maxBytes: number): ValidatedUpload {
  const size = input.bytes.length;
  if (size === 0) throw new ValidationError("The file is empty.");
  if (size > maxBytes) throw new AppError(413, "payload_too_large", `The file is larger than the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`);

  const fileName = sanitizeFileName(input.fileName);
  const exts = extensionsOf(fileName);
  const blocked = exts.find((e) => BLOCKED_EXTENSIONS.has(e)); // any segment, so "invoice.exe.pdf" is refused too
  if (blocked) throw new ValidationError(`.${blocked} files are not allowed.`);

  const contentType = input.declaredType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  if (!ALLOWED_MIME.has(contentType)) throw new ValidationError(`File type "${contentType}" is not allowed.`);
  const lastExt = exts[exts.length - 1] ?? "";
  if (contentType === "application/octet-stream" && !OCTET_STREAM_OK.has(lastExt)) throw new ValidationError("This file type is not allowed.");

  if (looksExecutable(input.bytes)) throw new ValidationError("Executable files are not allowed.");

  // The declared type, the extension and the real content must agree.
  const declared = MIME_FAMILY[contentType];
  const byExt = EXT_FAMILY[lastExt];
  if (declared && byExt && declared !== byExt) throw new ValidationError("The file extension does not match its type.");
  const expected = declared ?? byExt;
  if (expected) {
    const actual = sniffFamily(input.bytes);
    if (actual !== expected) throw new ValidationError("The file content does not match its type.");
  }
  if (contentType === "image/svg+xml" && !/<svg[\s>]/i.test(input.bytes.subarray(0, 4096).toString("utf8"))) {
    throw new ValidationError("The file content does not match its type.");
  }

  return { fileName, contentType, sizeBytes: size, sha256: createHash("sha256").update(input.bytes).digest("hex") };
}

/** Effective per-file cap: ATTACHMENT_MAX_BYTES, but never above 4 MB with database storage or on Vercel (request-body limit). */
export function effectiveMaxBytes(cfg: { ATTACHMENT_MAX_BYTES: number; STORAGE_PROVIDER: string }, env: Record<string, string | undefined> = process.env): number {
  const hardCap = cfg.STORAGE_PROVIDER === "database" || env.VERCEL === "1" ? 4 * 1024 * 1024 : Number.POSITIVE_INFINITY;
  return Math.min(cfg.ATTACHMENT_MAX_BYTES, hardCap);
}
