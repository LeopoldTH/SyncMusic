import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { openDatabase, type Db } from "./db";
import { createAuth, readAuthConfig, type AuthConfig } from "./auth";

/*
 * Tout le chemin de verification s exerce sans reseau: le token endpoint de Google est
 * stubbe et le jeton d identite signe contre un JWKS local. C est ce qui permet de
 * provoquer les cas d echec (mauvaise cle, mauvais destinataire, jeton expire) qu on ne
 * peut pas demander a Google de produire.
 */

const CLIENT_ID = "client-de-test.apps.googleusercontent.com";
const BASE_URL = "http://localhost:5173";
const SUB = "google-sub-leo";

const CONFIG: AuthConfig = {
  baseUrl: BASE_URL,
  origin: BASE_URL,
  secure: false,
  clientId: CLIENT_ID,
  clientSecret: "secret-de-test",
};

let jwks: JWTVerifyGetKey;
let signingKey: CryptoKey;
let autreCle: CryptoKey;

beforeAll(async () => {
  const paire = await generateKeyPair("RS256", { extractable: true });
  signingKey = paire.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(paire.publicKey)), alg: "RS256", kid: "test" }] });
  autreCle = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

async function idToken(options: {
  nonce: string;
  audience?: string;
  issuer?: string;
  expiration?: string | number;
  key?: CryptoKey;
  name?: string;
  email?: string;
  sub?: string;
}): Promise<string> {
  return new SignJWT({
    nonce: options.nonce,
    name: options.name ?? "Leopold Thomasset",
    email: options.email ?? "leo@example.com",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject(options.sub ?? SUB)
    .setIssuer(options.issuer ?? "https://accounts.google.com")
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "10m")
    .sign(options.key ?? signingKey);
}

/** Panier de cookies minimal: retient ce que le serveur pose, oublie ce qu il efface. */
class Jar {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = decodeURIComponent(first.slice(eq + 1).trim());
      if (value === "" || /max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }

  get(name: string): string | undefined { return this.jar.get(name); }
  set(name: string, value: string): void { this.jar.set(name, value); }
}

const ouverts: Server[] = [];

afterEach(async () => {
  await Promise.all(ouverts.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function banc(options: {
  config?: Partial<AuthConfig>;
  tokenResponse?: () => Response;
} = {}) {
  const db = openDatabase(":memory:");
  const config = { ...CONFIG, ...options.config };
  const jar = new Jar();
  const state = { appels: 0, idToken: "" };

  // Stub du token endpoint: rend le jeton que le test vient de fabriquer.
  const fetchImpl = (async () => {
    state.appels++;
    if (options.tokenResponse) return options.tokenResponse();
    return new Response(JSON.stringify({ id_token: state.idToken }), { status: 200 });
  }) as unknown as typeof fetch;

  const auth = createAuth({ config, db, jwks, fetchImpl });
  const server = createServer((request, response) => {
    void (async () => {
      if (await auth.handle(request, response)) return;
      response.writeHead(404);
      response.end();
    })();
  });
  ouverts.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    db, jar,
    get appelsTokenEndpoint() { return state.appels; },
    prochainJeton(jeton: string) { state.idToken = jeton; },

    async get(path: string): Promise<Response> {
      const response = await fetch(url + path, {
        redirect: "manual",
        headers: { Cookie: jar.header() },
      });
      jar.absorb(response);
      return response;
    },

    async post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
      const response = await fetch(url + path, {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: jar.header(), "Content-Type": "application/json", Origin: BASE_URL, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      jar.absorb(response);
      return response;
    },
  };
}

type Banc = Awaited<ReturnType<typeof banc>>;

/** Trajet complet: /auth/login puis /auth/callback. Rend la reponse du callback. */
async function connecter(b: Banc, jeton?: (nonce: string) => Promise<string>): Promise<Response> {
  const login = await b.get("/auth/login");
  const envoye = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const nonce = (b.jar.get("syncmusic_oauth") ?? "").split(".")[1] ?? "";
  b.prochainJeton(jeton ? await jeton(nonce) : await idToken({ nonce }));
  return b.get(`/auth/callback?code=code-valide&state=${encodeURIComponent(envoye)}`);
}

describe("configuration", () => {
  it("refuse de demarrer sans BASE_URL", () => {
    expect(() => readAuthConfig({})).toThrow(/BASE_URL est obligatoire/);
  });

  it("refuse une BASE_URL qui n est pas une adresse", () => {
    expect(() => readAuthConfig({ BASE_URL: "pas-une-url" })).toThrow(/adresse valide/);
  });

  it("retire le slash final et derive l origine", () => {
    const config = readAuthConfig({ BASE_URL: "https://syncmusic-leopold.fly.dev/" });
    expect(config.baseUrl).toBe("https://syncmusic-leopold.fly.dev");
    expect(config.origin).toBe("https://syncmusic-leopold.fly.dev");
  });

  it("pose les cookies Secure en https, pas en http", () => {
    expect(readAuthConfig({ BASE_URL: "https://exemple.fr" }).secure).toBe(true);
    expect(readAuthConfig({ BASE_URL: BASE_URL }).secure).toBe(false);
  });

  it("accepte l absence d identifiants Google", () => {
    expect(readAuthConfig({ BASE_URL: BASE_URL }).clientId).toBeNull();
  });
});

describe("sans identifiants Google", () => {
  it("repond 404 aux routes de connexion, l app reste utilisable en invite (R3)", async () => {
    const b = await banc({ config: { clientId: null, clientSecret: null } });
    expect((await b.get("/auth/login")).status).toBe(404);
    expect((await b.get("/api/me")).status).toBe(401);
  });
});

describe("depart vers Google", () => {
  it("redirige vers l ecran de consentement avec les bons parametres", async () => {
    const b = await banc();
    const response = await b.get("/auth/login");
    expect(response.status).toBe(302);

    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/auth/callback`);
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("scope")).toBe("openid email profile");
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("nonce")).toBeTruthy();
  });

  it("pose un cookie court qui porte state et nonce", async () => {
    const b = await banc();
    const cookie = (await b.get("/auth/login")).headers.getSetCookie()
      .find((c) => c.startsWith("syncmusic_oauth="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    // En http, ni Secure ni prefixe __Host-: Safari jetterait le cookie sans rien dire.
    expect(cookie).not.toMatch(/Secure/);
    expect(b.jar.get("syncmusic_oauth")?.split(".")).toHaveLength(2);
  });
});

describe("retour de Google", () => {
  it("cree la session et ramene a l accueil", async () => {
    const b = await banc();
    const response = await connecter(b);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const me = await b.get("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ name: "Leopold Thomasset" });
  });

  it("efface le cookie d aller et pose celui de session", async () => {
    const b = await banc();
    await connecter(b);
    expect(b.jar.get("syncmusic_oauth")).toBeUndefined();
    expect(b.jar.get("syncmusic_session")).toBeTruthy();
  });

  it("tronque le nom a la limite du protocole (KD5)", async () => {
    const b = await banc();
    await connecter(b, (nonce) => idToken({ nonce, name: "Jean-Baptiste de la Fontaine" }));
    expect(await (await b.get("/api/me")).json()).toEqual({ name: "Jean-Baptiste de la " });
  });

  it("retombe sur l email quand le profil n a pas de nom", async () => {
    const b = await banc();
    await connecter(b, (nonce) => idToken({ nonce, name: "", email: "leo@example.com" }));
    expect(await (await b.get("/api/me")).json()).toEqual({ name: "leo" });
  });

  it("refuse un state qui ne correspond pas au cookie, sans appeler Google (R12)", async () => {
    const b = await banc();
    await b.get("/auth/login");
    const response = await b.get("/auth/callback?code=c&state=state-invente");
    expect(response.headers.get("location")).toBe("/?auth=failed");
    expect(b.appelsTokenEndpoint).toBe(0);
  });

  it("refuse un callback sans cookie d aller", async () => {
    const b = await banc();
    const response = await b.get("/auth/callback?code=c&state=peu-importe");
    expect(response.headers.get("location")).toBe("/?auth=failed");
    expect(b.appelsTokenEndpoint).toBe(0);
  });

  it("ramene a l accueil quand l utilisateur refuse le consentement (R12)", async () => {
    const b = await banc();
    await b.get("/auth/login");
    const response = await b.get("/auth/callback?error=access_denied&state=x");
    expect(response.headers.get("location")).toBe("/?auth=failed");
    expect(b.appelsTokenEndpoint).toBe(0);
    expect((await b.get("/api/me")).status).toBe(401);
  });

  it("ne rejoue pas un callback deja consomme (cookie a usage unique)", async () => {
    const b = await banc();
    const login = await b.get("/auth/login");
    const envoye = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const nonce = (b.jar.get("syncmusic_oauth") ?? "").split(".")[1] ?? "";
    b.prochainJeton(await idToken({ nonce }));

    const chemin = `/auth/callback?code=code-valide&state=${encodeURIComponent(envoye)}`;
    expect((await b.get(chemin)).headers.get("location")).toBe("/");
    expect((await b.get(chemin)).headers.get("location")).toBe("/?auth=failed");
  });

  it("refuse un jeton signe par une autre cle", async () => {
    const b = await banc();
    const response = await connecter(b, (nonce) => idToken({ nonce, key: autreCle }));
    expect(response.headers.get("location")).toBe("/?auth=failed");
    expect((await b.get("/api/me")).status).toBe(401);
  });

  it("refuse un jeton destine a une autre application", async () => {
    const b = await banc();
    const response = await connecter(b, (nonce) => idToken({ nonce, audience: "une-autre-app" }));
    expect(response.headers.get("location")).toBe("/?auth=failed");
  });

  it("refuse un jeton expire", async () => {
    const b = await banc();
    const response = await connecter(b, (nonce) => idToken({ nonce, expiration: "-1m" }));
    expect(response.headers.get("location")).toBe("/?auth=failed");
  });

  it("refuse un jeton venu d un autre emetteur", async () => {
    const b = await banc();
    const response = await connecter(b, (nonce) => idToken({ nonce, issuer: "https://evil.example" }));
    expect(response.headers.get("location")).toBe("/?auth=failed");
  });

  it("refuse un jeton dont le nonce ne suit pas cette connexion", async () => {
    const b = await banc();
    const response = await connecter(b, () => idToken({ nonce: "nonce-d-ailleurs" }));
    expect(response.headers.get("location")).toBe("/?auth=failed");
  });

  it("accepte l autre forme d emetteur que Google emet aussi", async () => {
    const b = await banc();
    const response = await connecter(b, (nonce) => idToken({ nonce, issuer: "accounts.google.com" }));
    expect(response.headers.get("location")).toBe("/");
  });

  it("ramene a l accueil quand le token endpoint refuse", async () => {
    const b = await banc({ tokenResponse: () => new Response("nope", { status: 400 }) });
    const response = await connecter(b);
    expect(response.headers.get("location")).toBe("/?auth=failed");
  });

  it("reconnait le meme compte a la seconde connexion", async () => {
    const b = await banc();
    await connecter(b);
    await b.post("/auth/logout");
    await connecter(b);
    expect(await (await b.get("/api/me")).json()).toEqual({ name: "Leopold Thomasset" });
  });
});

describe("etat de la session", () => {
  it("repond 401 sans cookie, jamais une erreur serveur", async () => {
    const b = await banc();
    expect((await b.get("/api/me")).status).toBe(401);
  });

  it("repond 401 sur un cookie fabrique de toutes pieces", async () => {
    const b = await banc();
    b.jar.set("syncmusic_session", "identifiant-invente");
    const response = await b.get("/api/me");
    expect(response.status).toBe(401);
  });

  it("ne met jamais /api en cache", async () => {
    const b = await banc();
    expect((await b.get("/api/me")).headers.get("cache-control")).toBe("no-store");
  });

  it("invalide la session sur-le-champ a la deconnexion", async () => {
    const b = await banc();
    await connecter(b);
    expect((await b.post("/auth/logout")).status).toBe(204);
    expect(b.jar.get("syncmusic_session")).toBeUndefined();
    expect((await b.get("/api/me")).status).toBe(401);
  });

  it("refuse un POST venu d une autre origine", async () => {
    const b = await banc();
    await connecter(b);
    const response = await b.post("/auth/logout", undefined, { Origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect((await b.get("/api/me")).status).toBe(200);
  });
});

describe("nom du compte", () => {
  it("enregistre un nom choisi et le rend a la lecture", async () => {
    const b = await banc();
    await connecter(b);
    expect((await b.post("/api/name", { name: "Leo" })).status).toBe(200);
    expect(await (await b.get("/api/me")).json()).toEqual({ name: "Leo" });
  });

  it("resiste au rafraichissement du profil Google (KTD7)", async () => {
    const b = await banc();
    await connecter(b);
    await b.post("/api/name", { name: "Leo" });
    await b.post("/auth/logout");
    await connecter(b);
    expect(await (await b.get("/api/me")).json()).toEqual({ name: "Leo" });
  });

  it("refuse un nom de 21 caracteres", async () => {
    const b = await banc();
    await connecter(b);
    expect((await b.post("/api/name", { name: "x".repeat(21) })).status).toBe(400);
  });

  it("refuse un nom vide", async () => {
    const b = await banc();
    await connecter(b);
    expect((await b.post("/api/name", { name: "   " })).status).toBe(400);
  });

  it("refuse sans session", async () => {
    const b = await banc();
    expect((await b.post("/api/name", { name: "Leo" })).status).toBe(401);
  });

  it("refuse un corps qui n est pas l objet attendu", async () => {
    const b = await banc();
    await connecter(b);
    const response = await b.post("/api/name", "pas-du-json-objet");
    expect(response.status).toBe(400);
  });
});

describe("routes inconnues", () => {
  it("repond 404 sous /api sans tomber sur les fichiers du client", async () => {
    const b = await banc();
    expect((await b.get("/api/inexistant")).status).toBe(404);
  });
});
