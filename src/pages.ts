export type PageMessage = readonly [title: string, message: string];

const STYLE = [
  "body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;margin:0;",
  "display:grid;place-items:center;min-height:100vh}",
  "main{background:#2b2d31;padding:2rem 2.5rem;border-radius:12px;max-width:420px;text-align:center}",
  "h1{font-size:1.3rem;margin:0 0 .75rem}",
  "a{display:inline-block;margin-top:1.25rem;background:#5865f2;color:#fff;padding:.6rem 1.2rem;",
  "border-radius:6px;text-decoration:none}",
].join("");

export const MESSAGES = {
  cancelled: ["Login cancelado", "Você não autorizou o login com o Discord."],
  invalidState: ["Sessão de login inválida", "O link de login expirou ou é inválido."],
  missingCode: ["Login inválido", "O Discord não enviou o código de autorização."],
  notMember: ["Acesso negado", "Você precisa ser membro do servidor do Discord para entrar neste site."],
  discordDown: ["Erro no login", "Não foi possível falar com o Discord agora. Tente de novo em alguns minutos."],
} as const satisfies Record<string, PageMessage>;

export function renderPage([title, message]: PageMessage, retryHref?: string): string {
  const button = retryHref ? `<a href="${retryHref}">Tentar de novo</a>` : "";
  return [
    "<!doctype html>",
    "<html lang=\"pt-BR\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    `<body><main><h1>${title}</h1><p>${message}</p>${button}</main></body>`,
    "</html>",
  ].join("\n");
}
