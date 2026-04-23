/** Matches server `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$` in app/main.py */
export const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

const PROFILE_HEADER_ALIASES = new Set(["profile_name", "profile_id", "profile", "id"]);

const COOKIE_HEADERS = [
  "__Secure-1PSIDTS",
  "__Secure-1PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PSID",
] as const;

export type CsvProfileRow = {
  lineNumber: number;
  profileId: string;
  cookies: Record<string, string>;
};

function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) {
    return s.slice(1);
  }
  return s;
}

/** RFC4180-style: commas split fields; double quotes escape quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function normalizeHeader(h: string): string {
  return stripBom(h).trim();
}

export type ParsedProfilesCsv =
  | { ok: true; rows: CsvProfileRow[] }
  | { ok: false; error: string };

/**
 * Expects a header row. Required: a profile column (`profile_name`, `profile_id`, `profile`, or `id`)
 * and `__Secure-1PSID`. Optional: `__Secure-1PSIDTS`, `__Secure-3PSIDTS`, `__Secure-3PSID`.
 */
export function parseProfilesCookiesCsv(text: string): ParsedProfilesCsv {
  const raw = stripBom(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const lines = raw.split("\n").filter((ln) => ln.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, error: "CSV needs a header row and at least one data row." };
  }
  const headerCells = parseCsvLine(lines[0]).map(normalizeHeader);
  const lower = headerCells.map((h) => h.toLowerCase());

  let profileCol = -1;
  for (let i = 0; i < lower.length; i++) {
    if (PROFILE_HEADER_ALIASES.has(lower[i])) {
      profileCol = i;
      break;
    }
  }
  if (profileCol < 0) {
    return {
      ok: false,
      error: `Missing profile column. Use one of: ${[...PROFILE_HEADER_ALIASES].join(", ")}.`,
    };
  }

  const cookieColIndex: Partial<Record<(typeof COOKIE_HEADERS)[number], number>> = {};
  for (const name of COOKIE_HEADERS) {
    const j = headerCells.indexOf(name);
    if (j >= 0) {
      cookieColIndex[name] = j;
    }
  }
  if (cookieColIndex["__Secure-1PSID"] === undefined && cookieColIndex["__Secure-3PSID"] === undefined) {
    return {
      ok: false,
      error: "Missing cookie column __Secure-1PSID (or __Secure-3PSID).",
    };
  }

  const rows: CsvProfileRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const lineNumber = li + 1;
    const cells = parseCsvLine(lines[li]).map((c) => c.trim());
    const profileId = (cells[profileCol] ?? "").trim();
    if (!profileId) {
      continue;
    }
    const cookies: Record<string, string> = {};
    for (const name of COOKIE_HEADERS) {
      const idx = cookieColIndex[name];
      if (idx === undefined) {
        continue;
      }
      const v = (cells[idx] ?? "").trim();
      if (v) {
        cookies[name] = v;
      }
    }
    rows.push({ lineNumber, profileId, cookies });
  }

  if (!rows.length) {
    return { ok: false, error: "No data rows with a non-empty profile id." };
  }
  return { ok: true, rows };
}

export function validateProfileId(id: string): string | null {
  const t = id.trim();
  if (!t) {
    return "Empty profile id";
  }
  if (!PROFILE_ID_PATTERN.test(t)) {
    return "Invalid profile id (use letters, digits, ._- only; max 63 chars after first character).";
  }
  return null;
}

export function rowHasPsidCookie(cookies: Record<string, string>): boolean {
  const a = (cookies["__Secure-1PSID"] ?? "").trim();
  const b = (cookies["__Secure-3PSID"] ?? "").trim();
  return Boolean(a || b);
}
