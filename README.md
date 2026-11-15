# sso-mussarelos

Login com Discord para sites em Express. **Só entra quem é membro do servidor** que você configurar. Opcionalmente, salva os usuários no PostgreSQL para você editar dados deles depois.

- Sem `express-session` nem JWT de terceiros: a sessão é um cookie `HttpOnly` assinado (HMAC-SHA256).
- Proteção contra CSRF no login (`state`) e contra redirecionamento para sites externos.
- Única dependência opcional: `pg` (só se `SSO_SAVE_USERS=true`).
- Escrita em TypeScript (`strict`), com tipos prontos: `req.user` já vem tipado no seu projeto.

## 1. Configurar o Discord

1. Acesse <https://discord.com/developers/applications> e crie uma aplicação.
2. Em **OAuth2**, copie o **Client ID** e o **Client Secret**.
3. Em **OAuth2 > Redirects**, adicione a URL de callback de cada site, ex.:
   - `http://localhost:3000/auth/callback` (desenvolvimento)
   - `https://meusite.com/auth/callback` (produção)
4. Pegue o ID do servidor: no Discord, ative **Configurações > Avançado > Modo desenvolvedor**, clique com o botão direito no servidor e **Copiar ID do servidor**.

> Não precisa de bot. A biblioteca usa os escopos `identify` e `guilds.members.read`.

## 2. Instalar

Enquanto não estiver publicada no npm, instale direto da pasta (ou de um repositório git):

```bash
npm install express ../SSOMussarelos
```

O pacote usa o código compilado em `dist/`. Instalando pela pasta, rode `npm install && npm run build` dentro de `SSOMussarelos` sempre que mudar algo em `src/`. Instalando por um repositório git, o build roda sozinho (script `prepare`).

Se for salvar usuários, instale também o driver do PostgreSQL:

```bash
npm install pg
```

## 3. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DISCORD_CLIENT_ID` | sim | Client ID da aplicação (Developer Portal > OAuth2) |
| `DISCORD_CLIENT_SECRET` | sim | Client Secret da aplicação (Developer Portal > OAuth2) |
| `DISCORD_REDIRECT_URI` | sim | URL de callback, **igual** a uma das cadastradas em OAuth2 > Redirects |
| `DISCORD_GUILD_ID` | sim | ID do servidor que libera o acesso (passo 4 acima) |
| `SSO_SESSION_SECRET` | sim | Segredo com 32+ caracteres para assinar a sessão |
| `SSO_SAVE_USERS` | não | `true` para salvar usuários no banco (padrão `false`) |
| `DATABASE_URL` | se salvar | String de conexão do PostgreSQL, ex.: `postgres://usuario:senha@localhost:5432/meubanco` |
| `SSO_SESSION_MAX_AGE` | não | Duração da sessão em segundos (padrão `604800` = 7 dias) |

Gerar o segredo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Usar

```ts
import express from "express";

import { getUser, useDiscordSSO } from "sso-mussarelos";

const app = express();
const sso = useDiscordSSO(app);

app.get("/", sso.optionalAuth, (req, res) => {
  res.send(req.user ? `Olá, ${req.user.username}` : "<a href=\"/auth/login\">Entrar com Discord</a>");
});

app.get("/dashboard", sso.requireAuth, (req, res) => {
  const user = getUser(req);
  res.send(`Bem-vindo, ${user.nick ?? user.username}`);
});

app.use("/admin", sso.requireAuth);

app.listen(3000);
```

- `useDiscordSSO(app)` cria as rotas `/auth/login`, `/auth/callback`, `/auth/logout` e `/auth/me`.
- `sso.requireAuth` protege uma rota; com `app.use("/admin", sso.requireAuth)` protege tudo abaixo de `/admin`.
- `sso.optionalAuth` preenche `req.user` quando há sessão, mas deixa visitantes passarem.
- `getUser(req)` devolve o usuário como `SSOUser` (sem `null`) nas rotas com `requireAuth`. Fora delas, lança um erro avisando.

Funciona igual em JavaScript; é só não usar os tipos.

Rode com `node --env-file=.env server.js` ou use o pacote `dotenv`. Há um exemplo completo em `example/server.ts` (`npm run example`).

### O que tem em `req.user`

```ts
{
  id: "123456789012345678",
  username: "fulano",
  globalName: "Fulano",
  nick: "Fulaninho",
  avatar: "a1b2c3...",
  avatarUrl: "https://cdn.discordapp.com/avatars/...png",
  data: { theme: "dark" },
}
```

`nick` é o apelido no servidor configurado. `data` só existe com `SSO_SAVE_USERS=true`.

### Rotas criadas

| Rota | O que faz |
|---|---|
| `GET /auth/login?returnTo=/dashboard` | Manda para o Discord; depois volta para `returnTo` |
| `GET /auth/callback` | Recebe o retorno do Discord e confere se é membro do servidor |
| `POST /auth/logout` (ou `GET`) | Sai |
| `GET /auth/me` | JSON com o usuário logado (401 se não estiver) |

Quem não está logado e acessa uma rota com `requireAuth` é redirecionado para o login (navegador) ou recebe `401` em JSON (chamadas de API).

## 5. Salvando usuários no banco

Com `SSO_SAVE_USERS=true`, a tabela `sso_users` é criada sozinha na primeira vez:

| Coluna | Tipo | |
|---|---|---|
| `discord_id` | TEXT (PK) | |
| `username`, `global_name`, `avatar`, `guild_nick` | TEXT | atualizados a cada login |
| `data` | JSONB | **livre para você** (cargo no site, preferências...) — nunca é sobrescrito pelo login |
| `created_at`, `last_login_at` | TIMESTAMPTZ | |

Para ler e editar, use `sso.users`:

| Função | O que faz |
|---|---|
| `update(id, { role: "admin" })` | Mescla os campos em `data`, mantendo os outros |
| `replaceData(id, { role: "member" })` | Substitui `data` inteiro |
| `get(id)` | Busca um usuário (ou `null`) |
| `list()` | Lista todos, do login mais recente para o mais antigo |
| `remove(id)` | Apaga o usuário e revoga o acesso |

```ts
await sso.users?.update(getUser(req).id, { role: "admin" });
const user = await sso.users?.get("123456789012345678");
```

`sso.users` é `null` quando `SSO_SAVE_USERS` está desligado, por isso o `?.`.

O conteúdo de `data` aparece em `req.user.data` nas rotas protegidas. **Remover o usuário do banco derruba a sessão dele** na próxima requisição (ele pode logar de novo se ainda estiver no servidor).

Já tem um pool do `pg` no projeto? Passe ele: `useDiscordSSO(app, { pool })`.

## Opções avançadas

Tudo que vem das variáveis de ambiente também pode ser passado no código. Outras opções:

| Opção | Padrão | O que faz |
|---|---|---|
| `basePath` | `"/auth"` | Onde as rotas ficam |
| `afterLogin` | `"/"` | Destino depois do login quando não há `returnTo` |
| `afterLogout` | `"/"` | Destino depois de sair |
| `tableName` | `"sso_users"` | Nome da tabela no banco |
| `cookieName` | `"sso_session"` | Nome do cookie de sessão |
| `onDenied` | página padrão | Função `(req, res, discordUser)` chamada quando a pessoa não é do servidor |

```ts
useDiscordSSO(app, {
  basePath: "/auth",
  onDenied: (req, res) => res.status(403).send("Entra no servidor primeiro!"),
});
```

## Coisas para saber

- **Quem sai do servidor** continua logado até a sessão expirar (padrão 7 dias). Se precisar cortar na hora, diminua `SSO_SESSION_MAX_AGE` ou remova o usuário com `sso.users.remove()`.
- Trocar o `SSO_SESSION_SECRET` desloga todo mundo.
- Em produção use HTTPS: com `DISCORD_REDIRECT_URI` começando em `https://`, o cookie é marcado como `Secure` automaticamente.
- Se o site estiver atrás de proxy (Render, Railway, Nginx), adicione `app.set("trust proxy", 1)`.

## Tipos

Tudo é exportado de `sso-mussarelos`:

| Tipo | O que é |
|---|---|
| `SSOUser` | O usuário em `req.user` |
| `StoredUser` | O usuário como está salvo no banco |
| `UserData` | O conteúdo livre de `data` (`Record<string, unknown>`) |
| `UsersApi` | As funções de `sso.users` |
| `DiscordSSO` | O que `useDiscordSSO`/`createDiscordSSO` devolvem |
| `DiscordSSOOptions` | As opções aceitas |
| `DiscordUser`, `DiscordMember` | O que vem da API do Discord (usado em `onDenied`) |
| `PgPoolLike`, `PgQueryResult` | O formato de pool aceito em `pool` |

`req.user` é tipado automaticamente em todo o projeto assim que você importa a biblioteca. `data` é `Record<string, unknown>`: ao ler um campo, confira o tipo antes de usar (`typeof user.data?.role === "string"`).

## Estrutura do código

| Arquivo | Responsabilidade |
|---|---|
| `src/index.ts` | Monta o router do Express, os middlewares `requireAuth`/`optionalAuth` e o `getUser` |
| `src/types.ts` | Tipos públicos e a tipagem de `req.user` no Express |
| `src/config.ts` | Lê e valida as variáveis de ambiente (opções passadas no código têm prioridade) |
| `src/session.ts` | Cria e confere os cookies assinados; bloqueia `returnTo` que aponte para outro site |
| `src/discord.ts` | Fala com a API OAuth2 do Discord e checa se a pessoa é membro do servidor |
| `src/store.ts` | Guarda os usuários no PostgreSQL; o `pg` só é carregado quando `SSO_SAVE_USERS=true` |
| `src/pages.ts` | Páginas de erro (login cancelado, acesso negado...) |

Os imports internos usam `#src/arquivo.js`. O campo `imports` do `package.json` aponta isso para `src/*.ts` durante o desenvolvimento (condição `sso-source`, ligada no `tsconfig.json`) e para `dist/*.js` no pacote compilado.

Como funciona o login:

1. `/auth/login` gera um `state` aleatório, guarda num cookie assinado de 10 minutos junto com o `returnTo` e redireciona para o Discord.
2. O Discord volta em `/auth/callback`. O `state` precisa bater com o cookie, senão o login é recusado (proteção contra CSRF).
3. O código é trocado por um token, e a biblioteca busca o usuário e o membro no servidor configurado. Se a API responder 403/404 para o membro, a pessoa não é do servidor.
4. O cookie de sessão guarda só os dados públicos do usuário, assinado com `SSO_SESSION_SECRET`. O token do Discord não é guardado.

O código segue o padrão Mussarelos: TypeScript `strict` sem `any`, sem comentários no código (as explicações ficam aqui), aspas duplas, imports absolutos via `#src/...` e 2 espaços de indentação.

## Desenvolvimento

| Comando | O que faz |
|---|---|
| `npm run typecheck` | Confere os tipos de `src/`, `test/` e `example/` |
| `npm run build` | Compila `src/` para `dist/` (JS + `.d.ts`) |
| `npm test` | Typecheck, build e testes |
| `npm run example` | Sobe o exemplo de `example/server.ts` usando o `.env` |

Precisa de **Node 22.18 ou mais novo, de 64 bits**. São aceitas só as versões que ainda recebem correções de segurança (22, 24 e 26 LTS); para desenvolver, use a LTS mais recente. O compilador do TypeScript 7 é um programa nativo e não existe para Windows de 32 bits, e o próprio Node não tem versão de 32 bits desde a 23.

Os testes simulam a API do Discord e usam um PostgreSQL em memória (`pg-mem`).
