import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { checkMember, clearSession, createLoginUrl, finishLogin, loadSession, refreshSession } from "#src/browser.js";
import type { BrowserSSOOptions, KeyValueStorage } from "#src/browser.js";
import { GUILD_ID, MEMBER_ID, MEMBER_TOKEN, OUTSIDER_TOKEN, startFakeDiscord } from "#test/fake-discord.js";
import type { FakeDiscord } from "#test/fake-discord.js";

const CLIENT_ID = "1571607165565800629";
const REDIRECT_URI = "https://example.github.io/cinema/";
const ONE_WEEK_SECONDS = 604800;
const SHORT_EXPIRY_SECONDS = 30;
const MEMBER = { nick: "Apelido" };

class MemoryStorage implements KeyValueStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let discord: FakeDiscord;

before(async () => {
  discord = await startFakeDiscord();
});

after(() => discord.close());

function options(storage: KeyValueStorage = new MemoryStorage()): BrowserSSOOptions {
  return {
    clientId: CLIENT_ID,
    guildId: GUILD_ID,
    redirectUri: REDIRECT_URI,
    storage,
    discordApi: discord.url,
    authorizeUrl: `${discord.url}/oauth2/authorize`,
  };
}

function tokenFragment(token: string, expiresIn = ONE_WEEK_SECONDS): Record<string, string> {
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: String(expiresIn),
    scope: "identify guilds.members.read",
  };
}

function redirectBack(loginUrl: string, fragment: Record<string, string>): string {
  const state = new URL(loginUrl).searchParams.get("state") ?? "";
  return `${REDIRECT_URI}#${new URLSearchParams({ state, ...fragment })}`;
}

test("createLoginUrl pede ao Discord um acesso para site sem servidor", () => {
  const opts = options();
  const url = new URL(createLoginUrl(opts));

  assert.equal(`${url.origin}${url.pathname}`, `${discord.url}/oauth2/authorize`);
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "identify guilds.members.read");
  assert.match(url.searchParams.get("state") ?? "", /^[0-9a-f]{32}$/);
  assert.notEqual(new URL(createLoginUrl(opts)).searchParams.get("state"), url.searchParams.get("state"));
});

test("finishLogin ignora endereço sem resposta do Discord", async () => {
  const result = await finishLogin(options(), `${REDIRECT_URI}#sala-123`);
  assert.deepEqual(result, { status: "none" });
});

test("membro do servidor entra, a sessão fica salva e o returnTo volta", async () => {
  const opts = options();
  const before = Date.now();
  const result = await finishLogin(opts, redirectBack(createLoginUrl(opts, "#sala-1"), tokenFragment(MEMBER_TOKEN)));

  assert.equal(result.status, "ok");
  assert.ok(result.status === "ok");
  assert.equal(result.returnTo, "#sala-1");
  assert.equal(result.session.user.id, MEMBER_ID);
  assert.equal(result.session.user.nick, "Apelido");
  assert.equal(result.session.accessToken, MEMBER_TOKEN);
  assert.ok(result.session.expiresAt >= before + ONE_WEEK_SECONDS * 1000);
  assert.deepEqual(loadSession(opts), result.session);
});

test("retorno com state diferente é recusado e não salva sessão", async () => {
  const opts = options();
  createLoginUrl(opts);
  const forged = `${REDIRECT_URI}#${new URLSearchParams({ state: "f".repeat(32), ...tokenFragment(MEMBER_TOKEN) })}`;

  assert.deepEqual(await finishLogin(opts, forged), { status: "invalid" });
  assert.equal(loadSession(opts), null);
});

test("o mesmo retorno do Discord não vale duas vezes", async () => {
  const opts = options();
  const url = redirectBack(createLoginUrl(opts), tokenFragment(MEMBER_TOKEN));

  assert.equal((await finishLogin(opts, url)).status, "ok");
  assert.deepEqual(await finishLogin(opts, url), { status: "invalid" });
});

test("login cancelado no Discord devolve cancelled com o returnTo", async () => {
  const opts = options();
  const url = redirectBack(createLoginUrl(opts, "#sala-2"), { error: "access_denied" });

  assert.deepEqual(await finishLogin(opts, url), { status: "cancelled", returnTo: "#sala-2" });
});

test("quem não está no servidor não fica com sessão", async () => {
  const opts = options();
  const url = redirectBack(createLoginUrl(opts), tokenFragment(OUTSIDER_TOKEN));

  assert.deepEqual(await finishLogin(opts, url), { status: "not-member", returnTo: "" });
  assert.equal(loadSession(opts), null);
});

test("checkMember confere o acesso direto no Discord", async () => {
  const opts = options();

  assert.equal((await checkMember(opts, MEMBER_TOKEN))?.id, MEMBER_ID);
  assert.equal(await checkMember(opts, OUTSIDER_TOKEN), null);
  assert.equal(await checkMember(opts, "tok-falso"), null);
});

test("sessão perto de vencer é descartada", async () => {
  const storage = new MemoryStorage();
  const opts = options(storage);
  const url = redirectBack(createLoginUrl(opts), tokenFragment(MEMBER_TOKEN, SHORT_EXPIRY_SECONDS));

  assert.equal((await finishLogin(opts, url)).status, "ok");
  assert.equal(loadSession(opts), null);
  assert.equal(loadSession(opts), null);
});

test("sessão corrompida no navegador é descartada", () => {
  const storage = new MemoryStorage();
  storage.setItem("sso-mussarelos:session", "{não é json");
  assert.equal(loadSession(options(storage)), null);

  storage.setItem("sso-mussarelos:session", JSON.stringify({ accessToken: 1 }));
  assert.equal(loadSession(options(storage)), null);
});

test("refreshSession derruba quem saiu do servidor", async () => {
  const opts = options();
  await finishLogin(opts, redirectBack(createLoginUrl(opts), tokenFragment(MEMBER_TOKEN)));
  discord.setMember(MEMBER_TOKEN, null);
  try {
    assert.equal(await refreshSession(opts), null);
    assert.equal(loadSession(opts), null);
  } finally {
    discord.setMember(MEMBER_TOKEN, MEMBER);
  }
});

test("refreshSession atualiza o apelido e mantém a sessão", async () => {
  const opts = options();
  await finishLogin(opts, redirectBack(createLoginUrl(opts), tokenFragment(MEMBER_TOKEN)));
  discord.setMember(MEMBER_TOKEN, { nick: "Apelido novo" });
  try {
    assert.equal((await refreshSession(opts))?.user.nick, "Apelido novo");
    assert.equal(loadSession(opts)?.user.nick, "Apelido novo");
  } finally {
    discord.setMember(MEMBER_TOKEN, MEMBER);
  }
});

test("refreshSession sem sessão salva devolve null", async () => {
  assert.equal(await refreshSession(options()), null);
});

test("clearSession sai da conta neste navegador", async () => {
  const opts = options();
  await finishLogin(opts, redirectBack(createLoginUrl(opts), tokenFragment(MEMBER_TOKEN)));
  clearSession(opts);
  assert.equal(loadSession(opts), null);
});
