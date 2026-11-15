import type { DiscordMember, DiscordUser, SSOConfig } from "#src/types.js";

interface TokenResponse {
  access_token?: unknown;
}

const SCOPES = ["identify", "guilds.members.read"];
const CDN_URL = "https://cdn.discordapp.com";
const DEFAULT_AVATAR_COUNT = 6n;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;
const NOT_MEMBER_STATUSES = [403, 404];
const BAD_GATEWAY = 502;

export class DiscordError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
  }
}

async function apiGet(config: SSOConfig, path: string, token: string): Promise<Response> {
  return fetch(`${config.discordApi}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

export function buildAuthorizeUrl(config: SSOConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "none");
  return url.toString();
}

export async function exchangeCode(config: SSOConfig, code: string): Promise<string> {
  const res = await fetch(`${config.discordApi}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new DiscordError(`Falha ao trocar o código OAuth (${res.status})`, res.status);
  }

  const data = (await res.json()) as TokenResponse;
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new DiscordError("Resposta do Discord sem access_token", BAD_GATEWAY);
  }
  return data.access_token;
}

export async function fetchUser(config: SSOConfig, token: string): Promise<DiscordUser> {
  const res = await apiGet(config, "/users/@me", token);
  if (!res.ok) {
    throw new DiscordError(`Falha ao buscar o usuário (${res.status})`, res.status);
  }
  return (await res.json()) as DiscordUser;
}

export async function fetchGuildMember(config: SSOConfig, token: string): Promise<DiscordMember | null> {
  const res = await apiGet(config, `/users/@me/guilds/${config.guildId}/member`, token);
  if (NOT_MEMBER_STATUSES.includes(res.status)) {
    return null;
  }
  if (!res.ok) {
    throw new DiscordError(`Falha ao verificar o servidor (${res.status})`, res.status);
  }
  return (await res.json()) as DiscordMember;
}

export function avatarUrl(user: DiscordUser): string {
  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN_URL}/avatars/${user.id}/${user.avatar}.${extension}`;
  }

  const index = (BigInt(user.id) >> SNOWFLAKE_TIMESTAMP_SHIFT) % DEFAULT_AVATAR_COUNT;
  return `${CDN_URL}/embed/avatars/${index}.png`;
}
