import type { DiscordSSOOptions, SSOConfig } from "#src/types.js";

type RequiredKey = "clientId" | "clientSecret" | "redirectUri" | "guildId" | "sessionSecret";

type RawConfig = Omit<SSOConfig, RequiredKey | "secureCookies"> & { [K in RequiredKey]: string | undefined };

type StringOptionKey = RequiredKey | "databaseUrl";

const TRUE_VALUES = ["1", "true", "yes", "sim", "on"];
const DEFAULT_SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const GUILD_ID_PATTERN = /^\d{5,25}$/;
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;
const ERROR_PREFIX = "[sso-mussarelos]";
const SECRET_COMMAND = "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

const REQUIRED_KEYS: [RequiredKey, string][] = [
  ["clientId", "DISCORD_CLIENT_ID"],
  ["clientSecret", "DISCORD_CLIENT_SECRET"],
  ["redirectUri", "DISCORD_REDIRECT_URI"],
  ["guildId", "DISCORD_GUILD_ID"],
  ["sessionSecret", "SSO_SESSION_SECRET"],
];

function toBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return TRUE_VALUES.includes(value.trim().toLowerCase());
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function readOptions(overrides: DiscordSSOOptions, env: NodeJS.ProcessEnv): RawConfig {
  const pick = (key: StringOptionKey, envKey: string): string | undefined => overrides[key] ?? env[envKey];

  return {
    clientId: pick("clientId", "DISCORD_CLIENT_ID"),
    clientSecret: pick("clientSecret", "DISCORD_CLIENT_SECRET"),
    redirectUri: pick("redirectUri", "DISCORD_REDIRECT_URI"),
    guildId: pick("guildId", "DISCORD_GUILD_ID"),
    sessionSecret: pick("sessionSecret", "SSO_SESSION_SECRET"),
    saveUsers: toBool(overrides.saveUsers ?? env.SSO_SAVE_USERS, false),
    databaseUrl: pick("databaseUrl", "DATABASE_URL"),
    sessionMaxAge: Number(overrides.sessionMaxAge ?? env.SSO_SESSION_MAX_AGE ?? DEFAULT_SESSION_MAX_AGE),
    pool: overrides.pool,
    tableName: overrides.tableName ?? "sso_users",
    basePath: trimSlashes(overrides.basePath ?? "/auth"),
    cookieName: overrides.cookieName ?? "sso_session",
    afterLogin: overrides.afterLogin ?? "/",
    afterLogout: overrides.afterLogout ?? "/",
    onDenied: overrides.onDenied,
    discordApi: trimSlashes(overrides.discordApi ?? "https://discord.com/api/v10"),
    authorizeUrl: overrides.authorizeUrl ?? "https://discord.com/oauth2/authorize",
  };
}

function findMissing(raw: RawConfig): string[] {
  const missing = REQUIRED_KEYS.filter(([key]) => !raw[key]).map(([, envKey]) => envKey);

  if (raw.saveUsers && !raw.databaseUrl && !raw.pool) {
    missing.push("DATABASE_URL");
  }
  return missing;
}

function hasRequired(raw: RawConfig): raw is RawConfig & Record<RequiredKey, string> {
  return findMissing(raw).length === 0;
}

function validate(config: Omit<SSOConfig, "secureCookies">): void {
  if (config.sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${ERROR_PREFIX} SSO_SESSION_SECRET precisa ter pelo menos ${MIN_SECRET_LENGTH} caracteres. `
        + `Gere um com: ${SECRET_COMMAND}`,
    );
  }
  if (!GUILD_ID_PATTERN.test(config.guildId)) {
    throw new Error(`${ERROR_PREFIX} DISCORD_GUILD_ID deve ser o ID numérico do servidor.`);
  }
  if (!TABLE_NAME_PATTERN.test(config.tableName)) {
    throw new Error(`${ERROR_PREFIX} tableName só pode ter letras, números e _.`);
  }
  if (!Number.isFinite(config.sessionMaxAge) || config.sessionMaxAge <= 0) {
    throw new Error(`${ERROR_PREFIX} SSO_SESSION_MAX_AGE deve ser um número de segundos maior que 0.`);
  }
}

export function loadConfig(overrides: DiscordSSOOptions = {}): SSOConfig {
  const raw = readOptions(overrides, process.env);
  if (!hasRequired(raw)) {
    throw new Error(`${ERROR_PREFIX} Faltam variáveis de ambiente: ${findMissing(raw).join(", ")}`);
  }

  validate(raw);
  return { ...raw, secureCookies: overrides.secureCookies ?? raw.redirectUri.startsWith("https://") };
}
