import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { DiscordMember, DiscordUser } from "#src/index.js";

export interface FakeAccount {
  code: string;
  token: string;
  user: DiscordUser;
  member: DiscordMember | null;
}

export interface FakeDiscord {
  url: string;
  setMember(token: string, member: DiscordMember | null): void;
  close(): void;
}

export const GUILD_ID = "111111111111111111";
export const CLIENT_SECRET = "secret";
export const MEMBER_ID = "222222222222222222";
export const OUTSIDER_ID = "333333333333333333";
export const MEMBER_TOKEN = "tok-member";
export const OUTSIDER_TOKEN = "tok-outsider";

function createAccounts(): FakeAccount[] {
  return [
    {
      code: "code-member",
      token: MEMBER_TOKEN,
      user: { id: MEMBER_ID, username: "membro", global_name: "Membro", avatar: null },
      member: { nick: "Apelido" },
    },
    {
      code: "code-outsider",
      token: OUTSIDER_TOKEN,
      user: { id: OUTSIDER_ID, username: "intruso", global_name: null, avatar: "abc" },
      member: null,
    },
  ];
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

async function handleTokenRequest(accounts: FakeAccount[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = new URLSearchParams(await readBody(req));
  if (params.get("client_secret") !== CLIENT_SECRET) {
    sendJson(res, 401, {});
    return;
  }

  const account = accounts.find((candidate) => candidate.code === params.get("code"));
  if (!account) {
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  sendJson(res, 200, { access_token: account.token });
}

function handleApiRequest(accounts: FakeAccount[], req: IncomingMessage, res: ServerResponse): void {
  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  const account = accounts.find((candidate) => candidate.token === token);
  if (!account) {
    sendJson(res, 401, { message: "401: Unauthorized", code: 0 });
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

function handleCorsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization",
  });
  res.end();
}

export async function startFakeDiscord(): Promise<FakeDiscord> {
  const accounts = createAccounts();
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      handleCorsPreflight(res);
      return;
    }
    if (req.method === "POST" && req.url === "/oauth2/token") {
      void handleTokenRequest(accounts, req, res);
      return;
    }
    handleApiRequest(accounts, req, res);
  });
  const url = await listen(server);

  return {
    url,
    setMember(token: string, member: DiscordMember | null): void {
      const account = accounts.find((candidate) => candidate.token === token);
      if (account) {
        account.member = member;
      }
    },
    close(): void {
      server.close();
    },
  };
}
