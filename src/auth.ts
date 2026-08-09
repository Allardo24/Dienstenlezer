import { serverUrl } from "./serverUrl";

export type AccountRole = "user" | "admin";

export type Account = {
  id: string;
  username: string;
  role: AccountRole;
  enabled: boolean;
  passwordChangeRequired: boolean;
};

export type AuthSession = {
  account: Account;
  csrfToken: string;
};

let currentCsrfToken = "";

export function accountsAvailable(): boolean {
  return typeof window !== "undefined";
}

export async function getSetupStatus(): Promise<boolean> {
  if (!accountsAvailable()) {
    return false;
  }
  const response = await fetch(serverUrl("/api/auth/setup-status"), { cache: "no-store" });
  if (!response.ok) {
    throw await apiError(response);
  }
  return ((await response.json()) as { setupRequired: boolean }).setupRequired;
}

export async function restoreSession(): Promise<AuthSession | undefined> {
  if (!accountsAvailable()) {
    return undefined;
  }
  const response = await fetch(serverUrl("/api/auth/me"), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    currentCsrfToken = "";
    return undefined;
  }
  if (!response.ok) {
    throw await apiError(response);
  }
  return rememberSession((await response.json()) as AuthSession);
}

export async function login(username: string, password: string): Promise<AuthSession> {
  return authPost("/api/auth/login", { username, password });
}

export async function completeSetup(setupToken: string, username: string, password: string): Promise<AuthSession> {
  return authPost("/api/auth/setup", { setupToken, username, password });
}

export async function logout(): Promise<void> {
  if (!accountsAvailable()) {
    return;
  }
  const response = await fetch(serverUrl("/api/auth/logout"), withAuth({ method: "POST" }));
  currentCsrfToken = "";
  if (!response.ok && response.status !== 401) {
    throw await apiError(response);
  }
}

export async function logoutEverywhere(): Promise<void> {
  const response = await fetch(serverUrl("/api/auth/logout-all"), withAuth({ method: "POST" }));
  if (!response.ok) {
    throw await apiError(response);
  }
}

export async function changePassword(password: string): Promise<void> {
  await accountRequest("/api/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function listAdminAccounts(): Promise<Account[]> {
  const response = await accountRequest("/api/admin/accounts");
  return response.json() as Promise<Account[]>;
}

export function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (currentCsrfToken && !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())) {
    headers.set("X-DienstenLezer-CSRF", currentCsrfToken);
  }
  return { ...init, headers, credentials: "same-origin" };
}

export async function accountRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(serverUrl(path), withAuth({ ...init, cache: "no-store" }));
  if (!response.ok) {
    throw await apiError(response);
  }
  return response;
}

async function authPost(path: string, body: unknown): Promise<AuthSession> {
  const response = await fetch(serverUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await apiError(response);
  }
  return rememberSession((await response.json()) as AuthSession);
}

function rememberSession(session: AuthSession): AuthSession {
  currentCsrfToken = session.csrfToken;
  return session;
}

async function apiError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  return new Error(payload?.error ?? `Accountserver gaf HTTP ${response.status}.`);
}
