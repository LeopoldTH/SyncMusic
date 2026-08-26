import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAccount, saveAccountName, logout } from "./account";

function repond(status: number, payload: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("lecture du compte", () => {
  it("rend le compte quand le serveur le donne", async () => {
    repond(200, { name: "Leo" });
    expect(await fetchAccount()).toEqual({ name: "Leo" });
  });

  it("rend invite sur 401", async () => {
    repond(401, { error: "connexion requise" });
    expect(await fetchAccount()).toBeNull();
  });

  it("rend invite sur 404, deploiement sans identifiants Google (R3)", async () => {
    repond(404, { error: "connexion Google non configuree" });
    expect(await fetchAccount()).toBeNull();
  });

  it("rend invite sur une reponse de forme inattendue", async () => {
    repond(200, { nom: "Leo" });
    expect(await fetchAccount()).toBeNull();
  });

  it("rend invite quand le serveur est injoignable, sans lever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("reseau"); }));
    expect(await fetchAccount()).toBeNull();
  });
});

describe("enregistrement du nom", () => {
  it("rend le nom retenu par le serveur", async () => {
    repond(200, { name: "Leo" });
    expect(await saveAccountName("Leo")).toEqual({ ok: true, name: "Leo" });
  });

  it("remonte la raison du refus telle quelle", async () => {
    repond(400, { error: "nom trop long" });
    expect(await saveAccountName("x".repeat(21))).toEqual({ ok: false, reason: "nom trop long" });
  });

  it("garde une raison lisible quand le refus n en donne pas", async () => {
    repond(500, {});
    expect(await saveAccountName("Leo")).toMatchObject({ ok: false });
  });

  it("ne leve pas quand le serveur est injoignable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("reseau"); }));
    expect(await saveAccountName("Leo")).toEqual({ ok: false, reason: "serveur injoignable" });
  });
});

describe("deconnexion", () => {
  it("passe par un POST, jamais un GET: un GET serait declenchable par n importe quel site", async () => {
    const appel = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appel);
    await logout();
    expect(appel).toHaveBeenCalledWith("/auth/logout", { method: "POST" });
  });

  it("ne leve pas quand l appel echoue: la page se rechargera quand meme", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("reseau"); }));
    await expect(logout()).resolves.toBeUndefined();
  });
});
