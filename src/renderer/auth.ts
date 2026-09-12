import { runtimeConfigSchema, type RuntimeConfig } from "../shared/contracts";

const TOKEN_KEY = "budgeted-launcher-id-token";
const VERIFIER_KEY = "budgeted-launcher-pkce-verifier";
const STATE_KEY = "budgeted-launcher-oauth-state";
let config: RuntimeConfig;

export async function initializeAuth() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Runtime configuration is unavailable.");
    config = runtimeConfigSchema.parse(await response.json());
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    config = runtimeConfigSchema.parse({
      apiUrl: "https://launcher.local/", awsRegion: "us-east-1",
      userPoolId: "local", userPoolClientId: "local", cognitoDomain: "https://local.amazoncognito.com",
      callbackUrl: window.location.origin + "/", launcherVersion: "dev",
    });
  }
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (code) await exchangeCode(code, url.searchParams.get("state"));
  return { config, authenticated: Boolean(validToken()) || import.meta.env.DEV };
}

export function getRuntimeConfig() { return config; }
export function getIdToken() { return import.meta.env.DEV ? "development-token" : validToken(); }

export async function signIn() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL("/oauth2/authorize", config.cognitoDomain);
  url.searchParams.set("client_id", config.userPoolClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  window.location.assign(url);
}

export function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
  const url = new URL("/logout", config.cognitoDomain);
  url.searchParams.set("client_id", config.userPoolClientId);
  url.searchParams.set("logout_uri", config.callbackUrl);
  window.location.assign(url);
}

async function exchangeCode(code: string, returnedState: string | null) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!verifier || !expectedState || returnedState !== expectedState) throw new Error("The sign-in response could not be verified.");
  const body = new URLSearchParams({
    grant_type: "authorization_code", client_id: config.userPoolClientId, code,
    redirect_uri: config.callbackUrl, code_verifier: verifier,
  });
  const response = await fetch(new URL("/oauth2/token", config.cognitoDomain), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const tokens = await response.json() as { id_token?: string; error_description?: string };
  if (!response.ok || !tokens.id_token) throw new Error(tokens.error_description ?? "Sign-in failed.");
  sessionStorage.setItem(TOKEN_KEY, tokens.id_token);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
}

function validToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return undefined;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: number };
    if (!payload.exp || payload.exp * 1_000 < Date.now() + 30_000) { sessionStorage.removeItem(TOKEN_KEY); return undefined; }
    return token;
  } catch { sessionStorage.removeItem(TOKEN_KEY); return undefined; }
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
