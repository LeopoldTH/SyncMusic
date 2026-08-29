import { describe, it, expect } from "vitest";
import { parseSearchResponse } from "./youtubeSearch";

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
