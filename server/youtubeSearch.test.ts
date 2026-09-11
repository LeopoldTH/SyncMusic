import { describe, it, expect } from "vitest";
import { parseSearchResponse, searchVideos } from "./youtubeSearch";
import { mockFetch, restoreFetchAfterEach, httpStatus as status } from "./mockFetch";

restoreFetchAfterEach();

const CLEF = "clef-de-test";

/** Forme reelle de la reponse, relevee sur l API le 29/08/2026. */
function item(videoId: string, title: string, channelTitle = "Une chaine") {
  return { id: { kind: "youtube#video", videoId }, snippet: { title, channelTitle } };
}

describe("lecture d une reponse de recherche", () => {
  it("retient identifiant, titre et chaine", () => {
    const results = parseSearchResponse({
      items: [item("kJQP7kiw5Fk", "Despacito", "LuisFonsiVEVO")],
    });
    expect(results).toEqual([
      { videoId: "kJQP7kiw5Fk", title: "Despacito", channel: "LuisFonsiVEVO" },
    ]);
  });

  /*
   * Verifie sur la vraie API: les titres arrivent echappes en HTML. Sans decodage,
   * « Simon &amp; Garfunkel » s afficherait tel quel dans la file.
   */
  it("decode les entites HTML des titres", () => {
    const results = parseSearchResponse({
      items: [item("kJQP7kiw5Fk", "Simon &amp; Garfunkel &quot;live&quot; &#39;81")],
    });
    expect(results[0]?.title).toBe(`Simon & Garfunkel "live" '81`);
  });

  it("ne decode pas deux fois: une entite echappee le reste", () => {
    const results = parseSearchResponse({ items: [item("kJQP7kiw5Fk", "a &amp;lt; b")] });
    expect(results[0]?.title).toBe("a &lt; b");
  });

  it("ignore un resultat malforme sans perdre les autres", () => {
    const results = parseSearchResponse({
      items: [
        { id: { kind: "youtube#channel" } },        // une chaine: pas de videoId
        item("kJQP7kiw5Fk", "Celui qui compte"),
        { id: { videoId: "trop-court" }, snippet: { title: "x", channelTitle: "y" } },
      ],
    });
    expect(results.map((r) => r.videoId)).toEqual(["kJQP7kiw5Fk"]);
  });

  it("rend une liste vide sur une reponse illisible plutot que de lever", () => {
    expect(parseSearchResponse(null)).toEqual([]);
    expect(parseSearchResponse({})).toEqual([]);
    expect(parseSearchResponse({ items: "pas un tableau" })).toEqual([]);
  });

  it("borne un titre demesure", () => {
    const results = parseSearchResponse({ items: [item("kJQP7kiw5Fk", "x".repeat(500))] });
    expect(results[0]?.title.length).toBe(120);
  });
});

/*
 * Revue du 11/09/2026, #2. Le classement d un echec de l API vit dans youtubeApiError.ts,
 * partage avec les genres: ce test garde la recherche branchee dessus, un quota epuise
 * doit rester distinct d une panne.
 */
describe("appel de la recherche a l API", () => {
  it("distingue un quota epuise d une panne", async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }),
      { status: 403 },
    )));
    await expect(searchVideos("despacito", CLEF)).resolves.toEqual({ ok: false, reason: "quota" });

    // Un 403 pour une cle mal restreinte n est pas un quota: il ne repart pas demain.
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }),
      { status: 403 },
    )));
    await expect(searchVideos("despacito", CLEF)).resolves.toEqual({ ok: false, reason: "unavailable" });

    mockFetch(status(500));
    await expect(searchVideos("despacito", CLEF)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
