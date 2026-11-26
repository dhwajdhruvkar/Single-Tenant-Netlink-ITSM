import { withTimeout } from "@/platform/resilience";
import { logger } from "@/platform/logging/logger";

// Minimal Microsoft Graph GET client: bearer token, timeout, and bounded retry on 429/503 honouring Retry-After.
// Only https://graph.microsoft.com URLs are ever requested (nextLink/deltaLink values from Graph are validated).

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphRequestError extends Error {
  constructor(readonly status: number, message = `Graph request failed (${status})`) {
    super(message);
    this.name = "GraphRequestError";
  }
}

export interface GraphClientOptions {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound for a single Retry-After wait. */
  maxRetryWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function assertGraphUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "graph.microsoft.com") {
    throw new GraphRequestError(0, "Refusing to call a non-Graph URL");
  }
  return url;
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWait: number;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxWait = opts.maxRetryWaitMs ?? 60_000;
  }

  /** GET a path (relative to v1.0) or an absolute Graph URL. Returns parsed JSON, or null on 404. */
  async get<T>(pathOrUrl: string, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await this.request("GET", pathOrUrl, undefined, headers);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  /** POST a JSON body. Resolves with the HTTP status on success (Graph answers 202 with no body for sendMail); throws GraphRequestError otherwise. */
  async post(pathOrUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
    const res = await this.request("POST", pathOrUrl, body, headers);
    return res.status;
  }

  private async request(method: "GET" | "POST", pathOrUrl: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    // Only "/..." paths are relative; anything else must be an absolute https://graph.microsoft.com URL.
    const url = assertGraphUrl(pathOrUrl.startsWith("/") ? `${GRAPH_BASE}${pathOrUrl}` : pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.getToken();
      const res = await withTimeout(
        this.fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: "error",
        }),
        this.timeoutMs,
        "Graph request",
      );
      if (res.status === 404 && method === "GET") return res;
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        const wait = Math.min(parseRetryAfter(res.headers.get("retry-after")) ?? 1000 * 2 ** attempt, this.maxWait);
        logger.warn("graph throttled; retrying", { status: res.status, attempt: attempt + 1, waitMs: wait });
        await this.sleep(wait);
        continue;
      }
      if (!res.ok) throw new GraphRequestError(res.status);
      return res;
    }
  }
}
