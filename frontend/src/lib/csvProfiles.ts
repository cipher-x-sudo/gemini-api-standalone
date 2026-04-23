/** Server allows label/email up to 320 chars (CreateProfilePayload). */
export const MAX_PROFILE_LABEL_LENGTH = 320;

const PROFILE_NAME_HEADER_ALIASES = new Set(["profile_name", "profile_id", "profile", "id"]);

const COOKIE_HEADERS = [
  "__Secure-1PSIDTS",
  "__Secure-1PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PSID",
] as const;

export type CsvProfileRow = {
  lineNumber: number;
  /** Value from `profile_name` (or alias column) — stored as Label / email; not the API profile id. */
  profileLabel: string;
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
 * Expects a header row. Required: a name column (`profile_name`, `profile_id`, `profile`, or `id`)
 * and `__Secure-1PSID` (or `__Secure-3PSID`). Optional: `__Secure-1PSIDTS`, `__Secure-3PSIDTS`.
 */
export function parseProfilesCookiesCsv(text: string): ParsedProfilesCsv {
  const raw = stripBom(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const lines = raw.split("\n").filter((ln) => ln.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, error: "CSV needs a header row and at least one data row." };
  }
  const headerCells = parseCsvLine(lines[0]).map(normalizeHeader);
  const lower = headerCells.map((h) => h.toLowerCase());

  let nameCol = -1;
  for (let i = 0; i < lower.length; i++) {
    if (PROFILE_NAME_HEADER_ALIASES.has(lower[i])) {
      nameCol = i;
      break;
    }
  }
  if (nameCol < 0) {
    return {
      ok: false,
      error: `Missing name column. Use one of: ${[...PROFILE_NAME_HEADER_ALIASES].join(", ")}.`,
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
    const profileLabel = (cells[nameCol] ?? "").trim();
    if (!profileLabel) {
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
    rows.push({ lineNumber, profileLabel, cookies });
  }

  if (!rows.length) {
    return { ok: false, error: "No data rows with a non-empty profile_name (label) cell." };
  }
  return { ok: true, rows };
}

export function validateProfileLabel(label: string): string | null {
  const t = label.trim();
  if (!t) {
    return "Empty label";
  }
  if (t.length > MAX_PROFILE_LABEL_LENGTH) {
    return `Label exceeds ${MAX_PROFILE_LABEL_LENGTH} characters (server limit).`;
  }
  return null;
}

export function rowHasPsidCookie(cookies: Record<string, string>): boolean {
  const a = (cookies["__Secure-1PSID"] ?? "").trim();
  const b = (cookies["__Secure-3PSID"] ?? "").trim();
  return Boolean(a || b);
}
