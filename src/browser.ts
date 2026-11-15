import {
  buildAuthorizeUrl,
  DISCORD_API_URL,
  DISCORD_AUTHORIZE_URL,
  DiscordError,
  fetchGuildMember,
  fetchUser,
  toSSOUser,
} from "#src/discord.js";
import type { ApiConfig } from "#src/discord.js";
import type { SSOUser } from "#src/types.js";

export type { SSOUser } from "#src/types.js";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserSSOOptions {
  clientId: string;
  guildId: string;
  redirectUri: string;
  storage: KeyValueStorage;
  discordApi?: string;
  authorizeUrl?: string;
  storageKey?: string;
}

export type MemberCheckOptions = Pick<BrowserSSOOptions, "guildId" | "discordApi">;

export interface BrowserSession {
  accessToken: string;
  expiresAt: number;
  user: SSOUser;
}

export type LoginResult =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "cancelled"; returnTo: string }
  | { status: "not-member"; returnTo: string }
  | { status: "ok"; session: BrowserSession; returnTo: string };

interface SavedState {
  state: string;
  returnTo: string;
}

type StorageOptions = Pick<BrowserSSOOptions, "storage" | "storageKey">;

const DEFAULT_STORAGE_KEY = "sso-mussarelos";
const STATE_BYTES = 16;
const MS_PER_SECOND = 1000;
const EXPIRY_MARGIN_MS = 60 * MS_PER_SECOND;
const UNAUTHORIZED = 401;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function storageKey(options: StorageOptions, suffix: string): string {
  return `${options.storageKey ?? DEFAULT_STORAGE_KEY}:${suffix}`;
}

function apiConfig(options: MemberCheckOptions): ApiConfig {
  return { discordApi: (options.discordApi ?? DISCORD_API_URL).replace(/\/+$/, ""), guildId: options.guildId };
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(STATE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readJson(storage: KeyValueStorage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSavedState(value: unknown): value is SavedState {
  return isRecord(value) && typeof value.state === "string" && typeof value.returnTo === "string";
}

function isBrowserSession(value: unknown): value is BrowserSession {
  if (!isRecord(value) || typeof value.accessToken !== "string" || typeof value.expiresAt !== "number") {
    return false;
  }
  return isRecord(value.user) && typeof value.user.id === "string" && typeof value.user.username === "string";
}

function takeSavedState(options: StorageOptions): SavedState | null {
  const key = storageKey(options, "state");
  const saved = readJson(options.storage, key);
  options.storage.removeItem(key);
  return isSavedState(saved) ? saved : null;
}

function expiresInMs(params: URLSearchParams): number {
  const seconds = Number(params.get("expires_in"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * MS_PER_SECOND : 0;
}

function saveSession(options: StorageOptions, session: BrowserSession): void {
  options.storage.setItem(storageKey(options, "session"), JSON.stringify(session));
}

export function createLoginUrl(options: BrowserSSOOptions, returnTo = ""): string {
  const state = randomState();
  const saved: SavedState = { state, returnTo };
  options.storage.setItem(storageKey(options, "state"), JSON.stringify(saved));

  const authorize = {
    authorizeUrl: options.authorizeUrl ?? DISCORD_AUTHORIZE_URL,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
  };
  return buildAuthorizeUrl(authorize, state, "token");
}

export async function checkMember(options: MemberCheckOptions, accessToken: string): Promise<SSOUser | null> {
  if (!TOKEN_PATTERN.test(accessToken)) {
    return null;
  }

  const config = apiConfig(options);
  try {
    const discordUser = await fetchUser(config, accessToken);
    const member = await fetchGuildMember(config, accessToken);
    return member ? toSSOUser(discordUser, member) : null;
  } catch (error) {
    if (error instanceof DiscordError && error.status === UNAUTHORIZED) {
      return null;
    }
    throw error;
  }
}

export async function finishLogin(options: BrowserSSOOptions, url: string): Promise<LoginResult> {
  const params = new URLSearchParams(new URL(url).hash.slice(1));
  if (!params.has("access_token") && !params.has("error")) {
    return { status: "none" };
  }

  const saved = takeSavedState(options);
  if (!saved || params.get("state") !== saved.state) {
    return { status: "invalid" };
  }
  if (params.has("error")) {
    return { status: "cancelled", returnTo: saved.returnTo };
  }

  const accessToken = params.get("access_token") ?? "";
  const user = await checkMember(options, accessToken);
  if (!user) {
    return { status: "not-member", returnTo: saved.returnTo };
  }

  const session: BrowserSession = { accessToken, expiresAt: Date.now() + expiresInMs(params), user };
  saveSession(options, session);
  return { status: "ok", session, returnTo: saved.returnTo };
}

export function loadSession(options: StorageOptions): BrowserSession | null {
  const session = readJson(options.storage, storageKey(options, "session"));
  if (!isBrowserSession(session) || session.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
    clearSession(options);
    return null;
  }
  return session;
}

export async function refreshSession(options: BrowserSSOOptions): Promise<BrowserSession | null> {
  const session = loadSession(options);
  if (!session) {
    return null;
  }

  const user = await checkMember(options, session.accessToken);
  if (!user) {
    clearSession(options);
    return null;
  }

  const refreshed: BrowserSession = { ...session, user };
  saveSession(options, refreshed);
  return refreshed;
}

export function clearSession(options: StorageOptions): void {
  options.storage.removeItem(storageKey(options, "session"));
}
