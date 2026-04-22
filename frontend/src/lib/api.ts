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

export const api = {
  getLogs: (limit = 800) =>
    fetchWithAuth(`/admin/api/logs?limit=${encodeURIComponent(String(limit))}`) as Promise<LogsResponse>,
  getProfiles: () => fetchWithAuth("/admin/api/profiles"),
  createProfile: (profileId: string) => 
    fetchWithAuth("/admin/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId })
    }),
  deleteProfile: (profileId: string) => 
    fetchWithAuth(`/admin/api/profiles/${profileId}`, { method: "DELETE" }),
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
