import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
  path?: string;
}

interface TokenTimes {
  iat: number;
  exp: number;
}

export type TokenPayload<T extends object> = T & TokenTimes;

const MAX_RETURN_TO_LENGTH = 2000;

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hasValidSignature(body: string, signature: string, secret: string): boolean {
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(body, secret));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function decodePayload(body: string): unknown {
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isUnexpired(payload: unknown): payload is TokenTimes {
  if (typeof payload !== "object" || payload === null || !("exp" in payload)) {
    return false;
  }
  return typeof payload.exp === "number" && payload.exp >= nowSeconds();
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      return value;
    }
    throw error;
  }
}

export function createToken<T extends object>(payload: T, secret: string, maxAgeSeconds: number): string {
  const issuedAt = nowSeconds();
  const json = JSON.stringify({ ...payload, iat: issuedAt, exp: issuedAt + maxAgeSeconds });
  const body = Buffer.from(json).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function readToken<T extends object>(token: string | undefined, secret: string): TokenPayload<T> | null {
  if (typeof token !== "string") {
    return null;
  }

  const dot = token.indexOf(".");
  if (dot <= 0) {
    return null;
  }

  const body = token.slice(0, dot);
  if (!hasValidSignature(body, token.slice(dot + 1), secret)) {
    return null;
  }

  const payload = decodePayload(body);
  return isUnexpired(payload) ? (payload as TokenPayload<T>) : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    const key = part.slice(0, separator).trim();
    if (separator < 0 || !key || key in cookies) {
      continue;
    }
    cookies[key] = decodeCookieValue(part.slice(separator + 1).trim());
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  { maxAge, secure, path = "/" }: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(maxAge)}`);
  }
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function appendCookie(res: ServerResponse, cookie: string): void {
  const previous = res.getHeader("Set-Cookie");
  const list = previous === undefined ? [] : [previous].flat().map(String);
  res.setHeader("Set-Cookie", [...list, cookie]);
}

export function safeReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > MAX_RETURN_TO_LENGTH) {
    return fallback;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (/[\r\n]/.test(value)) {
    return fallback;
  }
  return value;
}
