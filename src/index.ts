import { randomBytes } from "node:crypto";

import { Router } from "express";
import type { Express, NextFunction, Request, Response } from "express";

import { loadConfig } from "#src/config.js";
import { avatarUrl, buildAuthorizeUrl, DiscordError, exchangeCode, fetchGuildMember, fetchUser } from "#src/discord.js";
import { MESSAGES, renderPage } from "#src/pages.js";
import type { PageMessage } from "#src/pages.js";
import { appendCookie, createToken, parseCookies, readToken, safeReturnTo, serializeCookie } from "#src/session.js";
import { createStore } from "#src/store.js";
import type { UserStore } from "#src/store.js";
import type { DiscordMember, DiscordSSO, DiscordSSOOptions, DiscordUser, SSOUser, UsersApi } from "#src/types.js";

export type {
  DeniedHandler,
  DiscordMember,
  DiscordSSO,
  DiscordSSOOptions,
  DiscordUser,
  PgPoolLike,
  PgQueryResult,
  SSOUser,
  StoredUser,
  UserData,
  UsersApi,
} from "#src/types.js";

interface StatePayload {
  state: string;
  returnTo: string;
}

interface SessionPayload {
  user: SSOUser;
}

type CallbackCheck = { ok: true; code: string; returnTo: string } | { ok: false; problem: PageMessage };

const STATE_COOKIE = "sso_state";
const STATE_MAX_AGE = 10 * 60;
const STATE_BYTES = 16;
const LOG_PREFIX = "[sso-mussarelos]";
const MISSING_USER_MESSAGE = `${LOG_PREFIX} getUser(req) foi chamado numa rota sem sso.requireAuth.`;

function buildSessionUser(discordUser: DiscordUser, member: DiscordMember): SSOUser {
  return {
    id: discordUser.id,
    username: discordUser.username,
    globalName: discordUser.global_name ?? null,
    nick: member.nick ?? null,
    avatar: discordUser.avatar ?? null,
    avatarUrl: avatarUrl(discordUser),
  };
}

function checkCallback(query: Request["query"], saved: StatePayload | null): CallbackCheck {
  if (query.error) {
    return { ok: false, problem: MESSAGES.cancelled };
  }
  if (!saved || typeof query.state !== "string" || query.state !== saved.state) {
    return { ok: false, problem: MESSAGES.invalidState };
  }
  if (typeof query.code !== "string" || !query.code) {
    return { ok: false, problem: MESSAGES.missingCode };
  }
  return { ok: true, code: query.code, returnTo: saved.returnTo };
}

function wantsHtml(req: Request): boolean {
  return req.method === "GET" && req.accepts(["html", "json"]) === "html";
}

function publicUsersApi(store: UserStore | null): UsersApi | null {
  if (!store) {
    return null;
  }
  return {
    get: store.get,
    list: store.list,
    update: store.update,
    replaceData: store.replaceData,
    remove: store.remove,
  };
}

export function createDiscordSSO(options: DiscordSSOOptions = {}): DiscordSSO {
  const config = loadConfig(options);
  const store = config.saveUsers ? createStore(config) : null;
  const loginPath = `${config.basePath}/login`;

  function setCookie(res: Response, name: string, value: string, maxAge: number): void {
    appendCookie(res, serializeCookie(name, value, { maxAge, secure: config.secureCookies }));
  }

  function clearCookie(res: Response, name: string): void {
    setCookie(res, name, "", 0);
  }

  function sendPage(res: Response, status: number, message: PageMessage): void {
    res.status(status).send(renderPage(message, loginPath));
  }

  function readSession(req: Request): SSOUser | null {
    const cookies = parseCookies(req.headers.cookie);
    return readToken<SessionPayload>(cookies[config.cookieName], config.sessionSecret)?.user ?? null;
  }

  async function resolveUser(req: Request, res: Response): Promise<SSOUser | null> {
    const user = readSession(req);
    if (!user || !store) {
      return user;
    }

    const row = await store.get(user.id);
    if (!row) {
      clearCookie(res, config.cookieName);
      return null;
    }
    return { ...user, data: row.data };
  }

  function denyUnauthenticated(req: Request, res: Response): void {
    if (wantsHtml(req)) {
      const returnTo = encodeURIComponent(req.originalUrl || "/");
      res.redirect(302, `${loginPath}?returnTo=${returnTo}`);
      return;
    }
    res.status(401).json({ error: "not_authenticated", login: loginPath });
  }

  async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await resolveUser(req, res);
      if (!user) {
        denyUnauthenticated(req, res);
        return;
      }
      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      req.user = await resolveUser(req, res);
      next();
    } catch (error) {
      next(error);
    }
  }

  function startLogin(req: Request, res: Response): void {
    const state = randomBytes(STATE_BYTES).toString("hex");
    const returnTo = safeReturnTo(req.query.returnTo, config.afterLogin);
    const stateToken = createToken<StatePayload>({ state, returnTo }, config.sessionSecret, STATE_MAX_AGE);

    setCookie(res, STATE_COOKIE, stateToken, STATE_MAX_AGE);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, buildAuthorizeUrl(config, state));
  }

  async function completeLogin(req: Request, res: Response, code: string, returnTo: string): Promise<void> {
    const token = await exchangeCode(config, code);
    const discordUser = await fetchUser(config, token);
    const member = await fetchGuildMember(config, token);

    if (!member) {
      clearCookie(res, config.cookieName);
      if (config.onDenied) {
        await config.onDenied(req, res, discordUser);
        return;
      }
      sendPage(res, 403, MESSAGES.notMember);
      return;
    }

    const user = buildSessionUser(discordUser, member);
    if (store) {
      await store.upsertFromLogin(user);
    }

    const sessionToken = createToken<SessionPayload>({ user }, config.sessionSecret, config.sessionMaxAge);
    setCookie(res, config.cookieName, sessionToken, config.sessionMaxAge);
    res.redirect(302, safeReturnTo(returnTo, config.afterLogin));
  }

  async function handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    const saved = readToken<StatePayload>(parseCookies(req.headers.cookie)[STATE_COOKIE], config.sessionSecret);
    res.setHeader("Cache-Control", "no-store");
    clearCookie(res, STATE_COOKIE);

    const check = checkCallback(req.query, saved);
    if (!check.ok) {
      sendPage(res, 400, check.problem);
      return;
    }

    try {
      await completeLogin(req, res, check.code, check.returnTo);
    } catch (error) {
      if (!(error instanceof DiscordError)) {
        next(error);
        return;
      }
      console.error(LOG_PREFIX, error.message);
      sendPage(res, 502, MESSAGES.discordDown);
    }
  }

  function logout(_req: Request, res: Response): void {
    clearCookie(res, config.cookieName);
    res.redirect(302, config.afterLogout);
  }

  function sendCurrentUser(req: Request, res: Response): void {
    res.json(req.user);
  }

  const router = Router();
  router.get("/login", startLogin);
  router.get("/callback", handleCallback);
  router.post("/logout", logout);
  router.get("/logout", logout);
  router.get("/me", requireAuth, sendCurrentUser);

  return {
    router,
    requireAuth,
    optionalAuth,
    users: publicUsersApi(store),
    basePath: config.basePath,
    close: async (): Promise<void> => store?.close(),
  };
}

export function getUser(req: Request): SSOUser {
  if (!req.user) {
    throw new Error(MISSING_USER_MESSAGE);
  }
  return req.user;
}

export function useDiscordSSO(app: Express, options?: DiscordSSOOptions): DiscordSSO {
  const sso = createDiscordSSO(options);
  app.use(sso.basePath, sso.router);
  return sso;
}

export default createDiscordSSO;
