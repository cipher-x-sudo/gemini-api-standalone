/** Unset, empty, or whitespace = same origin as the page. Set only when the API is on another origin (build-time). */
const _apiBaseRaw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? "";
const API_BASE = _apiBaseRaw === "" ? "" : _apiBaseRaw.replace(/\/$/, "");

export function getAdminKey() {
  return localStorage.getItem("ADMIN_API_KEY") || "";
}

export function setAdminKey(key: string) {
  localStorage.setItem("ADMIN_API_KEY", key);
}

export function getClientKey() {
  return localStorage.getItem("GEMINI_API_CLIENT_KEY") || "";
}

export function setClientKey(key: string) {
  localStorage.setItem("GEMINI_API_CLIENT_KEY", key);
}

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const key = getAdminKey();
  const headers = new Headers(options.headers || {});
  if (key) {
    headers.set("Authorization", `Bearer ${key}`);
  }
  
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.detail || `HTTP Error ${response.status}`);
  }
  return response.json();
}

/** Public /v1/* calls: profile header + optional client key only (no admin Bearer). */
export type V1DebugResult = {
  ok: boolean;
  status: number;
  durationMs: number;
  url: string;
  method: string;
  /** Safe-to-display header map (sensitive values masked). */
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseBody: unknown;
  responseRaw: string;
};

function _v1Headers(profileId: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Gemini-Profile", profileId.trim());
  const clientKey = getClientKey().trim();
  if (clientKey) {
    headers.set("X-Gemini-Api-Key", clientKey);
  }
  return headers;
}

function _headersForDisplay(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.toLowerCase() === "x-gemini-api-key" && v.length > 8) {
      out[k] = `${v.slice(0, 4)}…${v.slice(-4)}`;
    } else {
      out[k] = v;
    }
  });
  return out;
}

async function _fetchV1Json(
  path: string,
  profileId: string,
  requestBody: unknown,
): Promise<V1DebugResult> {
  const url = `${API_BASE}${path}`;
  const headers = _v1Headers(profileId);
  const body = JSON.stringify(requestBody ?? {});
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers, body });
  const raw = await res.text();
  const durationMs = Math.round(performance.now() - t0);
  let responseBody: unknown = null;
  try {
    responseBody = raw ? JSON.parse(raw) : null;
  } catch {
    responseBody = { _parseError: true, raw };
  }
  const reqHdrs = new Headers(headers);
  return {
    ok: res.ok,
    status: res.status,
    durationMs,
    url,
    method: "POST",
    requestHeaders: _headersForDisplay(reqHdrs),
    requestBody,
    responseBody,
    responseRaw: raw.length > 48_000 ? `${raw.slice(0, 48_000)}\n… [truncated]` : raw,
  };
}

export async function v1ListModels(profileId: string): Promise<V1DebugResult> {
  return _fetchV1Json("/v1/list-models", profileId, { cookies: null });
}

export type V1GenerateBody = {
  prompt: string;
  model?: string | null;
  responseMimeType?: string | null;
  cookies?: Record<string, unknown> | null;
};

export async function v1Generate(profileId: string, body: V1GenerateBody): Promise<V1DebugResult> {
  const payload: Record<string, unknown> = {
    prompt: body.prompt ?? "",
    cookies: body.cookies ?? null,
  };
  const m = (body.model ?? "").trim();
  if (m) {
    payload.model = m;
  }
  if (body.responseMimeType) {
    payload.responseMimeType = body.responseMimeType;
  }
  return _fetchV1Json("/v1/generate", profileId, payload);
}

export type LogLine = { t: string; level: string; logger: string; msg: string };

export type LogsResponse = {
  lines: LogLine[];
  bufferMax: number;
  returned: number;
  totalInBuffer: number;
};

export type AdminJobRow = {
  id: string;
  type: string;
  status: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastProfile?: string | null;
  detail?: string | null;
  ok?: boolean | null;
};

export type AdminJobsResponse = {
  serverTime: string;
  autoRotate: boolean;
  refreshIntervalSeconds: number;
  healthCheckIntervalSeconds: number;
  redis: { configured: boolean; connected: boolean };
  jobs: AdminJobRow[];
};

export type GenerationEvent = {
  requestId?: string;
  profile?: string;
  ok?: boolean;
  httpStatus?: number;
  error?: string;
  model?: string | null;
  promptChars?: number;
  imageCount?: number;
  responseChars?: number;
  endpoint?: string;
  recordedAt?: string;
};

export type AdminGenerationsResponse = {
  limit: number;
  offset: number;
  returned: number;
  generations: GenerationEvent[];
  redis: { configured: boolean; connected: boolean };
};

export type ImportCsvResponse = {
  ok?: boolean;
  storedFile?: string;
  createdCount?: number;
  skipped?: number;
  profiles?: string[];
  failures?: string[];
};

export type BulkDeleteProfilesResponse = {
  ok?: boolean;
  deleted?: string[];
  errors?: { profile: string; detail: string }[];
};

async function fetchMultipartWithAuth(url: string, formData: FormData) {
  const key = getAdminKey();
  const headers = new Headers();
  if (key) {
    headers.set("Authorization", `Bearer ${key}`);
  }
  const response = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    const detail = errorData?.detail;
    const msg =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? JSON.stringify(detail)
          : detail
            ? JSON.stringify(detail)
            : `HTTP Error ${response.status}`;
    throw new Error(msg);
  }
  return response.json();
}

export const api = {
  getLogs: (limit = 800) =>
    fetchWithAuth(`/admin/api/logs?limit=${encodeURIComponent(String(limit))}`) as Promise<LogsResponse>,
  getProfiles: () => fetchWithAuth("/admin/api/profiles"),
  createProfile: (opts: {
    profileId?: string | null;
    email?: string | null;
    cookies?: unknown;
  }) => {
    const body: Record<string, unknown> = {};
    const pid = (opts.profileId ?? "").trim();
    if (pid) {
      body.profileId = pid;
    } else {
      body.profileId = "auto";
    }
    const em = (opts.email ?? "").trim();
    if (em) {
      body.email = em;
    }
    if (opts.cookies !== undefined) {
      body.cookies = opts.cookies;
    }
    return fetchWithAuth("/admin/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Promise<{
      ok?: boolean;
      profile?: string;
      email?: string | null;
      cookiesSaved?: boolean;
      autoAssignedId?: boolean;
    }>;
  },
  setProfileLabel: (profileId: string, email: string | null) =>
    fetchWithAuth(`/admin/api/profiles/${encodeURIComponent(profileId)}/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email && email.trim() ? email.trim() : null }),
    }),
  deleteProfile: (profileId: string) =>
    fetchWithAuth(`/admin/api/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" }),
  /** Upload CSV; server saves file under profiles/_csv_uploads/ and creates one profile per row. */
  importProfilesCsv: (file: File) =>
    fetchMultipartWithAuth("/admin/api/profiles/import-csv", (() => {
      const fd = new FormData();
      fd.append("file", file);
      return fd;
    })()) as Promise<ImportCsvResponse>,
  bulkDeleteProfiles: (body: { all?: boolean; profileIds?: string[] }) =>
    fetchWithAuth("/admin/api/profiles/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Promise<BulkDeleteProfilesResponse>,
  /** Live Gemini session probe for every profile (can take minutes). Persists last account status per profile. */
  getProfilesAuthStatus: () => fetchWithAuth("/admin/api/profiles/auth-status"),
  getCookies: (profileId: string) => 
    fetchWithAuth(`/admin/api/profiles/${profileId}/cookies`),
  setCookies: (profileId: string, cookies: any) =>
    fetchWithAuth(`/admin/api/profiles/${profileId}/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies })
    }),
  getJobs: () => fetchWithAuth("/admin/api/jobs") as Promise<AdminJobsResponse>,
  getGenerations: (limit = 50, offset = 0) =>
    fetchWithAuth(
      `/admin/api/generations?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`,
    ) as Promise<AdminGenerationsResponse>,
  checkStatus: async (profileId: string) => {
    const headers: Record<string, string> = { 
      "Content-Type": "application/json",
      "X-Gemini-Profile": profileId
    };
    const clientKey = getClientKey();
    if (clientKey) {
      headers["X-Gemini-Api-Key"] = clientKey;
    }

    const response = await fetch(`${API_BASE}/v1/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.detail || `HTTP Error ${response.status}`);
    }
    return response.json();
  }
};
