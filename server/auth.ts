/*
 * Connexion Google et sessions (KTD1, KTD2, KTD4).
 *
 * Le flow « authorization code » est code a la main, sans JavaScript Google dans la
 * page: trois echanges HTTP stables depuis dix ans, la ou la bibliotheque de bouton
 * Google a change de comportement deux fois depuis 2024 et ne couvre pas Safari.
 *
 * Ce module ne connait rien aux rooms. Il rend un handler HTTP qui dit s il a traite
 * la requete; tout ce qu il ne reconnait pas retombe sur le service des fichiers.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Db, User } from "./db";

/*
 * Endpoints Google, ecrits en dur. Ils viennent du discovery document
 * https://accounts.google.com/.well-known/openid-configuration et n ont pas bouge
 * depuis des annees. Les decouvrir au demarrage ajouterait un appel reseau qui peut
 * echouer, pour une valeur deja connue.
 */
const GOOGLE = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  /* Google emet l une ou l autre forme selon l anciennete du client: les deux valent. */
  issuers: ["https://accounts.google.com", "accounts.google.com"],
} as const;

/** Bornes du protocole de room: le nom de compte sert de pseudo, il tient dedans (KD5). */
const NAME_MAX_CHARS = 20;
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;
const SESSION_COOKIE_MAX_AGE_S = 60 * 24 * 60 * 60;
const TOKEN_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 16 * 1024;

export interface AuthConfig {
  /** Adresse publique reellement navigee, sans slash final. */
  baseUrl: string;
  /** Origine derivee de baseUrl: seule origine acceptee sur les POST (et sur l upgrade WS). */
  origin: string;
  /** En https: cookies `Secure` et prefixe `__Host-`. */
  secure: boolean;
  clientId: string | null;
  clientSecret: string | null;
}

/*
 * BASE_URL est obligatoire, OAuth configure ou non (KTD5). Elle sert la redirect URI
 * envoyee a Google et l origine autorisee: jamais deduite du header `Host`, qu un
 * client choisit librement. Une variable requise avec un message clair vaut mieux
 * qu un comportement qui change en silence selon ce qui est defini.
 */
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const raw = env["BASE_URL"];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "BASE_URL est obligatoire: l adresse publique de l application, par exemple " +
      "http://localhost:5173 en developpement. Voir .env.example.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`BASE_URL n est pas une adresse valide: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`BASE_URL doit etre en http ou https: ${raw}`);
  }

  const clientId = env["GOOGLE_CLIENT_ID"]?.trim() || null;
  const clientSecret = env["GOOGLE_CLIENT_SECRET"]?.trim() || null;
  return {
    baseUrl: url.origin + url.pathname.replace(/\/$/, ""),
    origin: url.origin,
    secure: url.protocol === "https:",
    clientId,
    clientSecret,
  };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    jar.set(name, decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return jar;
}

/*
 * `__Host-` exige `Secure` et `Path=/`, et interdit `Domain`: le cookie ne peut alors
 * plus etre pose par un sous-domaine voisin. Safari refuse `Secure` sur
 * http://localhost, donc en developpement on retombe sur un nom simple plutot que sur
 * un cookie que le navigateur jette sans rien dire.
 */
export function cookieNames(secure: boolean): { session: string; oauth: string } {
  const prefix = secure ? "__Host-" : "";
  return { session: `${prefix}syncmusic_session`, oauth: `${prefix}syncmusic_oauth` };
}

function setCookie(
  response: ServerResponse,
  name: string,
  value: string,
  options: { maxAgeSec: number; secure: boolean },
): void {
  /*
   * SameSite=Lax et pas Strict: le retour de Google est une navigation venue d un
   * autre site. Strict ferait ignorer le cookie au callback, et la connexion
   * echouerait sans message.
   */
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSec}`,
  ];
  if (options.secure) parts.push("Secure");
  response.appendHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(response: ServerResponse, name: string, secure: boolean): void {
  setCookie(response, name, "", { maxAgeSec: 0, secure });
}

/** 128 bits de la source cryptographique du systeme: state, nonce et session. */
function randomToken(): string {
  return randomBytes(16).toString("base64url");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // L historique et le nom d un compte sont prives (R7): aucun cache intermediaire.
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

/*
 * Un POST venu d un autre site ne doit rien pouvoir declencher ici. Les navigateurs
 * posent un header `Origin` sur tout POST; `Sec-Fetch-Site` sert de second temoin.
 * Un client sans ni l un ni l autre (curl) est refuse: c est le comportement voulu.
 */
function sameOrigin(request: IncomingMessage, config: AuthConfig): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined) return origin === config.origin;
  return request.headers["sec-fetch-site"] === "same-origin";
}

/** Rend null au-dela du plafond: un corps sans borne est de la memoire offerte (KTD9). */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/*
 * Le nom vient du profil Google et sert de pseudo en room, ou le protocole s arrete a
 * 20 caracteres. On tronque a l enregistrement plutot qu a l affichage: sinon le nom
 * montre dans l ecran de compte ne serait pas celui que les autres voient.
 */
function accountName(claims: JWTPayload): string {
  const name = claims["name"];
  const email = claims["email"];
  const fromProfile = typeof name === "string" ? name.trim() : "";
  const fromEmail = typeof email === "string" ? (email.split("@")[0] ?? "") : "";
  const chosen = fromProfile || fromEmail || "Compte Google";
  return chosen.slice(0, NAME_MAX_CHARS);
}

const NameBody = z.object({
  name: z.string().trim().min(1, "choisis un nom").max(NAME_MAX_CHARS, "nom trop long"),
});

export interface AuthDeps {
  config: AuthConfig;
  db: Db;
  /** Injecte en test: un JWKS local evite tout appel reseau (execution note de U2). */
  jwks?: JWTVerifyGetKey;
  /** Injecte en test: stub du token endpoint de Google. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  newToken?: () => string;
}

export function createAuth(deps: AuthDeps) {
  const { config, db } = deps;
  const now = deps.now ?? (() => Date.now());
  const token = deps.newToken ?? randomToken;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const names = cookieNames(config.secure);
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const configured = config.clientId !== null && config.clientSecret !== null;

  // Cree une seule fois: jose met en cache les cles Google et gere leur rotation.
  const jwks = deps.jwks ?? createRemoteJWKSet(new URL(GOOGLE.jwks));

  /** Le compte derriere le cookie de session, ou null. Un cookie absent = invite (KTD5). */
  function sessionFromCookies(cookieHeader: string | undefined): { user: User; rawId: string } | null {
    const rawId = parseCookies(cookieHeader).get(names.session);
    if (rawId === undefined || rawId === "") return null;
    const user = db.findSession(rawId, now());
    return user ? { user, rawId } : null;
  }

  function login(response: ServerResponse): void {
    const state = token();
    const nonce = token();
    /*
     * `state` protege du CSRF sur le callback, `nonce` lie le jeton d identite a cette
     * connexion precise. Les deux voyagent dans un seul cookie court, HttpOnly.
     */
    setCookie(response, names.oauth, `${state}.${nonce}`, {
      maxAgeSec: OAUTH_COOKIE_MAX_AGE_S, secure: config.secure,
    });

    const target = new URL(GOOGLE.authorization);
    target.searchParams.set("client_id", config.clientId ?? "");
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("state", state);
    target.searchParams.set("nonce", nonce);
    redirect(response, target.toString());
  }

  async function exchangeCode(code: string): Promise<string | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TOKEN_TIMEOUT_MS);
    try {
      const response = await fetchImpl(GOOGLE.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId ?? "",
          client_secret: config.clientSecret ?? "",
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
        signal: abort.signal,
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      const idToken = (payload as { id_token?: unknown }).id_token;
      return typeof idToken === "string" ? idToken : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callback(
    url: URL, request: IncomingMessage, response: ServerResponse,
  ): Promise<void> {
    const pending = parseCookies(request.headers.cookie).get(names.oauth);
    /*
     * Le cookie `state` est a usage unique et s efface avant toute verification: sans
     * ca, rejouer la meme URL de callback rejouerait la connexion.
     */
    clearCookie(response, names.oauth, config.secure);
    const failed = (): void => redirect(response, "/?auth=failed");

    /* Refus du consentement, ou erreur cote Google: retour a l accueil en invite (R12). */
    if (url.searchParams.get("error") !== null) return failed();

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const [expectedState, nonce] = (pending ?? "").split(".");
    if (!code || !state || !expectedState || !nonce || state !== expectedState) return failed();

    try {
      const idToken = await exchangeCode(code);
      if (idToken === null) return failed();

      /*
       * jose verifie la signature contre les cles publiques de Google, l emetteur, le
       * destinataire et l expiration. Le `nonce` se verifie a la main: c est lui qui
       * interdit de rejouer un jeton obtenu ailleurs.
       */
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: [...GOOGLE.issuers],
        audience: config.clientId ?? "",
      });
      if (payload.nonce !== nonce) return failed();
      if (typeof payload.sub !== "string" || payload.sub === "") return failed();

      const email = typeof payload["email"] === "string" ? payload["email"] : null;
      const user = db.upsertUser(
        { googleSub: payload.sub, name: accountName(payload), email }, now(),
      );

      const sessionId = token();
      db.createSession(sessionId, user.id, now());
      setCookie(response, names.session, sessionId, {
        maxAgeSec: SESSION_COOKIE_MAX_AGE_S, secure: config.secure,
      });
      /* Destination fixe: pas de parametre de retour, donc pas de redirection ouverte. */
      redirect(response, "/");
    } catch {
      /*
       * Signature invalide, reseau coupe, reponse illisible: meme sortie. Rien n est
       * journalise ici, le contexte contient le code et le jeton d identite.
       */
      failed();
    }
  }

  function logout(request: IncomingMessage, response: ServerResponse): void {
    const session = sessionFromCookies(request.headers.cookie);
    if (session) db.deleteSession(session.rawId);
    clearCookie(response, names.session, config.secure);
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
  }

  async function setName(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = sessionFromCookies(request.headers.cookie);
    if (!session) return sendJson(response, 401, { error: "connexion requise" });

    const body = await readBody(request, MAX_BODY_BYTES);
    if (body === null) return sendJson(response, 413, { error: "corps trop volumineux" });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(response, 400, { error: "corps illisible" });
    }
    const parsed = NameBody.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return sendJson(response, 400, { error: first?.message ?? "nom invalide" });
    }
    db.setUserName(session.user.id, parsed.data.name);
    sendJson(response, 200, { name: parsed.data.name });
  }

  return {
    sessionFromCookies,

    /** Rend true si la requete a ete traitee; false laisse la main au service statique. */
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", config.origin);
      const path = url.pathname;
      if (!path.startsWith("/auth/") && !path.startsWith("/api/")) return false;

      const method = request.method ?? "GET";

      /*
       * Sans identifiants Google, les routes de connexion n existent pas et l app
       * reste entierement utilisable en invite (R3): un deploiement non configure est
       * un mode de fonctionnement normal, pas une panne.
       */
      if (path.startsWith("/auth/") && !configured) {
        sendJson(response, 404, { error: "connexion Google non configuree" });
        return true;
      }

      if (method === "POST" && !sameOrigin(request, config)) {
        sendJson(response, 403, { error: "origine refusee" });
        return true;
      }

      if (path === "/auth/login" && method === "GET") {
        login(response);
        return true;
      }
      if (path === "/auth/callback" && method === "GET") {
        await callback(url, request, response);
        return true;
      }
      if (path === "/auth/logout" && method === "POST") {
        logout(request, response);
        return true;
      }
      if (path === "/api/me" && method === "GET") {
        const session = sessionFromCookies(request.headers.cookie);
        if (session === null) {
          sendJson(response, 401, { error: "connexion requise" });
          return true;
        }
        /*
         * La page appelle /api/me a chaque chargement: c est le point naturel ou la
         * fenetre glissante de session se repousse (KTD4).
         */
        db.renewSession(session.rawId, now());
        sendJson(response, 200, { name: session.user.name });
        return true;
      }
      if (path === "/api/name" && method === "POST") {
        await setName(request, response);
        return true;
      }

      sendJson(response, 404, { error: "route inconnue" });
      return true;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
