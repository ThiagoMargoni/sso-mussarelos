import express from "express";
import type { Request, Response } from "express";

import { getUser, useDiscordSSO } from "#src/index.js";
import type { SSOUser } from "#src/index.js";

const DEFAULT_PORT = 3000;

const app = express();
app.use(express.json());

const sso = useDiscordSSO(app);

function displayName(user: SSOUser): string {
  return user.nick ?? user.globalName ?? user.username;
}

function home(req: Request, res: Response): void {
  if (!req.user) {
    res.send("<a href=\"/auth/login\">Entrar com Discord</a>");
    return;
  }
  res.send(`
    <img src="${req.user.avatarUrl}" width="48" style="border-radius:50%">
    <p>Olá, ${displayName(req.user)}!</p>
    <a href="/secret">Área secreta</a> · <a href="/auth/logout">Sair</a>`);
}

function secret(req: Request, res: Response): void {
  res.send(`Só membros do servidor veem isso. Seus dados salvos: ${JSON.stringify(getUser(req).data ?? {})}`);
}

async function savePreferences(req: Request, res: Response): Promise<void> {
  if (!sso.users) {
    res.status(400).json({ error: "SSO_SAVE_USERS está desligado" });
    return;
  }
  const body = req.body as { theme?: unknown };
  const updated = await sso.users.update(getUser(req).id, { theme: body.theme });
  res.json(updated);
}

app.get("/", sso.optionalAuth, home);
app.get("/secret", sso.requireAuth, secret);
app.post("/api/preferences", sso.requireAuth, savePreferences);

const port = Number(process.env.PORT ?? DEFAULT_PORT);
app.listen(port, () => console.log(`Rodando em http://localhost:${port}`));
