import type { Request, RequestHandler, Response, Router } from "express";

export type UserData = Record<string, unknown>;

export interface SSOUser {
  id: string;
  username: string;
  globalName: string | null;
  nick: string | null;
  avatar: string | null;
  avatarUrl: string;
  data?: UserData;
}

export interface StoredUser {
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  guildNick: string | null;
  data: UserData;
  createdAt: Date;
  lastLoginAt: Date;
}

export interface UsersApi {
  get(discordId: string): Promise<StoredUser | null>;
  list(): Promise<StoredUser[]>;
  update(discordId: string, patch: UserData): Promise<StoredUser | null>;
  replaceData(discordId: string, data: UserData): Promise<StoredUser | null>;
  remove(discordId: string): Promise<boolean>;
}

export interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  end?(): Promise<void>;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordMember {
  nick?: string | null;
  roles?: string[];
}

export type DeniedHandler = (req: Request, res: Response, discordUser: DiscordUser) => unknown;

export interface DiscordSSOOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  guildId?: string;
  sessionSecret?: string;
  saveUsers?: boolean;
  databaseUrl?: string;
  pool?: PgPoolLike;
  sessionMaxAge?: number;
  tableName?: string;
  basePath?: string;
  cookieName?: string;
  afterLogin?: string;
  afterLogout?: string;
  secureCookies?: boolean;
  onDenied?: DeniedHandler;
  discordApi?: string;
  authorizeUrl?: string;
}

export interface SSOConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  guildId: string;
  sessionSecret: string;
  saveUsers: boolean;
  databaseUrl: string | undefined;
  pool: PgPoolLike | undefined;
  sessionMaxAge: number;
  tableName: string;
  basePath: string;
  cookieName: string;
  afterLogin: string;
  afterLogout: string;
  secureCookies: boolean;
  onDenied: DeniedHandler | undefined;
  discordApi: string;
  authorizeUrl: string;
}

export interface DiscordSSO {
  router: Router;
  requireAuth: RequestHandler;
  optionalAuth: RequestHandler;
  users: UsersApi | null;
  basePath: string;
  close(): Promise<void>;
}

declare global {
  namespace Express {
    interface Request {
      user?: SSOUser | null;
    }
  }
}
