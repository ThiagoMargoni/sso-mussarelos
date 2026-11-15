import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import express from "express";
import type { Request } from "express";
import { DataType, newDb } from "pg-mem";

import { createDiscordSSO, getUser, useDiscordSSO } from "#src/index.js";
import type {
  DiscordMember,
  DiscordSSO,
  DiscordSSOOptions,
  DiscordUser,
  PgPoolLike,
  SSOUser,
  UserData,
} from "#src/index.js";

interface FakeAccount {
  token: string;
  user: DiscordUser;
  member: DiscordMember | null;
}

interface TestApp {
  url: string;
  sso: DiscordSSO;
  close: () => void;
}

interface LoginResult {
  res: Response;
  cookie: string;
}

interface UserBody {
  user: SSOUser;
}

const GUILD_ID = "111111111111111111";
const SECRET = "x".repeat(40);
const CLIENT_SECRET = "secret";
const MEMBER_ID = "222222222222222222";
const OUTSIDER_ID = "333333333333333333";
const SHORT_SESSION_SECONDS = 1;
const EXPIRY_WAIT_MS = 2100;

const FAKE_ACCOUNTS: Record<string, FakeAccount> = {
  "code-member": {
    token: "tok-member",
    user: { id: MEMBER_ID, username: "membro", global_name: "Membro", avatar: null },
    member: { nick: "Apelido" },
  },
  "code-outsider": {
    token: "tok-outsider",
    user: { id: OUTSIDER_ID, username: "intruso", global_name: null, avatar: "abc" },
    member: null,
  },
};

const ACCOUNTS_BY_TOKEN: Record<string, FakeAccount> = Object.fromEntries(
  Object.values(FAKE_ACCOUNTS).map((account) => [account.token, account]),
);

let discordServer: Server;
let discordUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

async function handleTokenRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = new URLSearchParams(await readBody(req));
  if (params.get("client_secret") !== CLIENT_SECRET) {
    sendJson(res, 401, {});
    return;
  }

  const account = FAKE_ACCOUNTS[params.get("code") ?? ""];
  if (!account) {
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  sendJson(res, 200, { access_token: account.token });
}

function handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
  const account = ACCOUNTS_BY_TOKEN[(req.headers.authorization ?? "").replace("Bearer ", "")];
  if (!account) {
    sendJson(res, 401, {});
    return;
  }
  if (req.url === "/users/@me") {
    sendJson(res, 200, account.user);
    return;
  }
  if (req.url !== `/users/@me/guilds/${GUILD_ID}/member`) {
    sendJson(res, 404, {});
    return;
  }
  sendJson(res, account.member ? 200 : 404, account.member ?? { code: 10004 });
}

function handleFakeDiscord(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "POST" && req.url === "/oauth2/token") {
    void handleTokenRequest(req, res);
    return;
  }
  handleApiRequest(req, res);
}

before(async () => {
  discordServer = http.createServer(handleFakeDiscord);
  discordUrl = await listen(discordServer);
});

after(() => discordServer.close());

function baseOptions(extra: DiscordSSOOptions = {}): DiscordSSOOptions {
  return {
    clientId: "cid",
    clientSecret: CLIENT_SECRET,
    redirectUri: "http://localhost/auth/callback",
    guildId: GUILD_ID,
    sessionSecret: SECRET,
    discordApi: discordUrl,
    authorizeUrl: `${discordUrl}/authorize`,
    saveUsers: false,
    ...extra,
  };
}

async function startApp(options: DiscordSSOOptions): Promise<TestApp> {
  const app = express();
  const sso = useDiscordSSO(app, options);
  app.get("/private", sso.requireAuth, (req, res) => {
    res.json({ ok: true, user: getUser(req) });
  });

  const server = http.createServer(app);
  const url = await listen(server);
  return { url, sso, close: () => server.close() };
}

function cookiesFrom(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => !cookie.endsWith("="));
}

async function login(url: string, code: string, returnTo = "/private"): Promise<LoginResult> {
  const loginRes = await fetch(`${url}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  assert.equal(loginRes.status, 302);

  const authorizeUrl = new URL(loginRes.headers.get("location") ?? "");
  assert.equal(authorizeUrl.searchParams.get("scope"), "identify guilds.members.read");

  const state = authorizeUrl.searchParams.get("state") ?? "";
  const callbackRes = await fetch(`${url}/auth/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: cookiesFrom(loginRes).join("; ") },
  });
  return { res: callbackRes, cookie: cookiesFrom(callbackRes).join("; ") };
}

function getJson(url: string, cookie: string): Promise<Response> {
  return fetch(url, { headers: { cookie, accept: "application/json" } });
}

async function readUser(res: Response): Promise<SSOUser> {
  const body = (await res.json()) as UserBody;
  return body.user;
}

function flipFirstChar(cookie: string): string {
  const [name = "", value = ""] = cookie.split("=");
  const flipped = value.replace(/^./, (char) => (char === "A" ? "B" : "A"));
  return `${name}=${flipped}`;
}

function mergeJsonb(left: UserData, right: UserData): UserData {
  return { ...left, ...right };
}

function memoryPool(): PgPoolLike {
  const db = newDb();
  db.getSchema("pg_catalog").registerOperator({
    operator: "||",
    left: DataType.jsonb,
    right: DataType.jsonb,
    returns: DataType.jsonb,
    implementation: mergeJsonb,
  });

  const { Pool } = db.adapters.createPg();
  return new Pool() as PgPoolLike;
}

test("falta de variável obrigatória dá erro claro", () => {
  assert.throws(() => createDiscordSSO({ ...baseOptions(), guildId: undefined }), /DISCORD_GUILD_ID/);
  assert.throws(() => createDiscordSSO({ ...baseOptions(), sessionSecret: "curto" }), /32 caracteres/);
  assert.throws(() => createDiscordSSO(baseOptions({ saveUsers: true })), /DATABASE_URL/);
});

test("getUser fora de rota protegida dá erro claro", () => {
  assert.throws(() => getUser({} as Request), /sso\.requireAuth/);
});

test("lê configuração das variáveis de ambiente", () => {
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    DISCORD_CLIENT_ID: "a",
    DISCORD_CLIENT_SECRET: "b",
    DISCORD_REDIRECT_URI: "https://x.com/auth/callback",
    DISCORD_GUILD_ID: GUILD_ID,
    SSO_SESSION_SECRET: SECRET,
    SSO_SAVE_USERS: "false",
  });

  try {
    assert.equal(createDiscordSSO().users, null);
  } finally {
    process.env = savedEnv;
  }
});

test("visitante é redirecionado para o login; API recebe 401", async () => {
  const app = await startApp(baseOptions());
  try {
    const html = await fetch(`${app.url}/private`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(html.status, 302);
    assert.equal(html.headers.get("location"), "/auth/login?returnTo=%2Fprivate");

    const api = await getJson(`${app.url}/private`, "");
    assert.equal(api.status, 401);
  } finally {
    app.close();
  }
});

test("membro do servidor consegue entrar e volta para returnTo", async () => {
  const app = await startApp(baseOptions());
  try {
    const { res, cookie } = await login(app.url, "code-member");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/private");
    assert.match(res.headers.getSetCookie().join(), /HttpOnly; SameSite=Lax/);

    const privateRes = await getJson(`${app.url}/private`, cookie);
    assert.equal(privateRes.status, 200);

    const user = await readUser(privateRes);
    assert.equal(user.id, MEMBER_ID);
    assert.equal(user.nick, "Apelido");
    assert.match(user.avatarUrl, /embed\/avatars\/\d\.png$/);

    const me = (await (await getJson(`${app.url}/auth/me`, cookie)).json()) as SSOUser;
    assert.equal(me.username, "membro");

    const logoutRes = await fetch(`${app.url}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie },
    });
    assert.match(logoutRes.headers.getSetCookie()[0] ?? "", /sso_session=; .*Max-Age=0/);
  } finally {
    app.close();
  }
});

test("quem não está no servidor recebe 403 e nenhuma sessão", async () => {
  const app = await startApp(baseOptions());
  try {
    const { res, cookie } = await login(app.url, "code-outsider");
    assert.equal(res.status, 403);
    assert.match(await res.text(), /membro do servidor/);
    assert.equal(cookie, "");
  } finally {
    app.close();
  }
});

test("state inválido, cookie adulterado e returnTo externo são bloqueados", async () => {
  const app = await startApp(baseOptions());
  try {
    const badState = await fetch(`${app.url}/auth/callback?code=code-member&state=errado`, { redirect: "manual" });
    assert.equal(badState.status, 400);

    const { cookie } = await login(app.url, "code-member");
    const tampered = await getJson(`${app.url}/private`, flipFirstChar(cookie));
    assert.equal(tampered.status, 401);

    const external = await login(app.url, "code-member", "//evil.com");
    assert.equal(external.res.headers.get("location"), "/");
  } finally {
    app.close();
  }
});

test("sessão expirada não vale", async () => {
  const app = await startApp(baseOptions({ sessionMaxAge: SHORT_SESSION_SECONDS }));
  try {
    const { cookie } = await login(app.url, "code-member");
    await new Promise((resolve) => setTimeout(resolve, EXPIRY_WAIT_MS));

    const expired = await getJson(`${app.url}/private`, cookie);
    assert.equal(expired.status, 401);
  } finally {
    app.close();
  }
});

test("com SSO_SAVE_USERS: salva, edita data e revoga ao remover", async () => {
  const app = await startApp(baseOptions({ saveUsers: true, pool: memoryPool() }));
  const users = app.sso.users;
  assert.ok(users);
  try {
    const { cookie } = await login(app.url, "code-member");
    const saved = await users.get(MEMBER_ID);
    assert.equal(saved?.username, "membro");
    assert.equal(saved?.guildNick, "Apelido");
    assert.deepEqual(saved?.data, {});

    await users.update(MEMBER_ID, { role: "admin" });
    await users.update(MEMBER_ID, { theme: "dark" });
    const user = await readUser(await getJson(`${app.url}/private`, cookie));
    assert.deepEqual(user.data, { role: "admin", theme: "dark" });

    await login(app.url, "code-member");
    assert.deepEqual((await users.get(MEMBER_ID))?.data, { role: "admin", theme: "dark" });

    await users.replaceData(MEMBER_ID, { role: "member" });
    assert.deepEqual((await users.get(MEMBER_ID))?.data, { role: "member" });
    assert.equal((await users.list()).length, 1);
    await assert.rejects(users.update(MEMBER_ID, "texto" as unknown as Record<string, unknown>), /objeto/);

    assert.equal(await users.remove(MEMBER_ID), true);
    const revoked = await getJson(`${app.url}/private`, cookie);
    assert.equal(revoked.status, 401);

    await login(app.url, "code-outsider");
    assert.equal(await users.get(OUTSIDER_ID), null);
  } finally {
    app.close();
  }
});
