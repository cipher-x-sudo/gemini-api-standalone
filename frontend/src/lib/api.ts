const API_BASE = "http://localhost:8000";

export function getAdminKey() {
  return localStorage.getItem("ADMIN_API_KEY") || "";
}

export function setAdminKey(key: string) {
  localStorage.setItem("ADMIN_API_KEY", key);
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

export const api = {
  getProfiles: () => fetchWithAuth("/admin/api/profiles"),
  createProfile: (profileId: string) => 
    fetchWithAuth("/admin/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId })
    }),
  deleteProfile: (profileId: string) => 
    fetchWithAuth(`/admin/api/profiles/${profileId}`, { method: "DELETE" }),
  getCookies: (profileId: string) => 
    fetchWithAuth(`/admin/api/profiles/${profileId}/cookies`),
  setCookies: (profileId: string, cookies: any) =>
    fetchWithAuth(`/admin/api/profiles/${profileId}/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies })
    }),
  checkStatus: async (profileId: string) => {
    // Note: /v1/status doesn't use ADMIN_API_KEY, it uses X-Gemini-Profile header
    // and optionally X-Gemini-Api-Key which we might not have in the UI.
    const response = await fetch(`${API_BASE}/v1/status`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-Gemini-Profile": profileId
      },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.detail || `HTTP Error ${response.status}`);
    }
    return response.json();
  }
};
