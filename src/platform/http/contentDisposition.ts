/**
 * `Content-Disposition: attachment` with an ASCII fallback plus an RFC 5987 UTF-8 name. Quotes, backslashes, CR/LF and other
 * control characters can never reach the header, so a file name cannot inject headers or break out of the quoted string.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\;]/g, "_");
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
