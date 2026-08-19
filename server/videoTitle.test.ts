import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchVideoTitle } from "./videoTitle";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(impl: (...args: unknown[]) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("recuperation du titre", () => {
  it("rend le titre annonce par oEmbed", async () => {
    mockFetch(() => ok({ title: "Luis Fonsi - Despacito ft. Daddy Yankee" }));
    await expect(fetchVideoTitle("kJQP7kiw5Fk")).resolves.toBe("Luis Fonsi - Despacito ft. Daddy Yankee");
  });

  it("interroge bien l identifiant demande", async () => {
    let seen = "";
    mockFetch((...args: unknown[]) => { seen = String(args[0]); return ok({ title: "x" }); });
    await fetchVideoTitle("kJQP7kiw5Fk");
    expect(seen).toContain("kJQP7kiw5Fk");
    expect(seen).toContain("format=json");
  });

  it("rend null sur une video introuvable", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 404 })));
    await expect(fetchVideoTitle("kJQP7kiw5Fk")).resolves.toBe(null);
  });

  it("rend null quand le reseau echoue, sans lever", async () => {
    // Une video privee ou un reseau capricieux ne doit pas empecher d ajouter un morceau.
    mockFetch(() => Promise.reject(new Error("reseau")));
    await expect(fetchVideoTitle("kJQP7kiw5Fk")).resolves.toBe(null);
  });

  it("rend null quand la reponse n a pas de titre", async () => {
    mockFetch(() => ok({ author_name: "LuisFonsiVEVO" }));
    await expect(fetchVideoTitle("kJQP7kiw5Fk")).resolves.toBe(null);
  });
});
