/**
 * Reduce a post-login destination to a local path + query. The host of any absolute or protocol-relative URL is discarded
 * (it can be the server's bind address behind a proxy, or an attacker's host), so this can never redirect off-site.
 */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value) return "/";
  try {
    const url = new URL(value, "http://placeholder.invalid");
    const path = `${url.pathname}${url.search}`;
    return path.startsWith("/") && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}
