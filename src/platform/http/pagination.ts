import { ValidationError } from "@/platform/errors";

export type SortDirection = "asc" | "desc";

export interface PaginationOptions<K extends string> {
  defaultSortBy: K;
  allowedSortBy: readonly K[];
  defaultSortDir?: SortDirection;
  defaultPageSize?: number;
  maxPageSize?: number;
}

export interface Pagination<K extends string> {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  sortBy: K;
  sortDir: SortDirection;
}

function positiveInt(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new ValidationError(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${name} is too large.`);
  return value;
}

/** Parse page/pageSize/sortBy/sortDir from a URL's query string; throws ValidationError. */
export function parsePagination<K extends string>(url: URL | string, options: PaginationOptions<K>): Pagination<K> {
  const params = (typeof url === "string" ? new URL(url) : url).searchParams;
  const maxPageSize = options.maxPageSize ?? 100;
  const page = positiveInt(params.get("page") ?? "1", "page");
  const pageSize = positiveInt(params.get("pageSize") ?? String(options.defaultPageSize ?? 25), "pageSize");
  if (pageSize > maxPageSize) throw new ValidationError(`pageSize must be at most ${maxPageSize}.`);

  const sortBy = params.get("sortBy") ?? options.defaultSortBy;
  if (!options.allowedSortBy.includes(sortBy as K)) {
    throw new ValidationError(`sortBy must be one of: ${options.allowedSortBy.join(", ")}.`);
  }
  const sortDir = params.get("sortDir") ?? options.defaultSortDir ?? "desc";
  if (sortDir !== "asc" && sortDir !== "desc") throw new ValidationError("sortDir must be one of: asc, desc.");

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, sortBy: sortBy as K, sortDir };
}

export function pageMeta(total: number, p: Pick<Pagination<string>, "page" | "pageSize">) {
  return { total, page: p.page, pageSize: p.pageSize, totalPages: Math.ceil(total / p.pageSize) };
}
