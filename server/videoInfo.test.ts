import { describe, it, expect } from "vitest";
import { fetchVideoInfo, fetchEachVideoInfo } from "./videoInfo";
import { mockFetch, restoreFetchAfterEach, jsonOk as ok, httpStatus as status } from "./mockFetch";

restoreFetchAfterEach();

/** Laisse tourner les microtaches ET la file des timers: le pool en depend. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const REPONSE_UTILE = {
  title: "Luis Fonsi - Despacito ft. Daddy Yankee",
  author_name: "LuisFonsiVEVO",
  thumbnail_url: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
};

describe("recuperation des informations d une video", () => {
  it("rend le titre, le nom de chaine et l adresse de miniature (R2, R3)", async () => {
    mockFetch(() => ok(REPONSE_UTILE));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({
      ok: true,
      title: "Luis Fonsi - Despacito ft. Daddy Yankee",
      channelTitle: "LuisFonsiVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    });
  });

  it("interroge bien l identifiant demande", async () => {
    let seen = "";
    mockFetch((...args: unknown[]) => { seen = String(args[0]); return ok(REPONSE_UTILE); });
    await fetchVideoInfo("kJQP7kiw5Fk");
    expect(seen).toContain("kJQP7kiw5Fk");
    expect(seen).toContain("format=json");
  });

  it("rend le titre seul quand la reponse n a pas de nom de chaine, sans lever", async () => {
    mockFetch(() => ok({ title: "Un live sans chaine" }));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({
      ok: true, title: "Un live sans chaine", channelTitle: null, thumbnailUrl: null,
    });
  });

  it("rend un titre nul quand la reponse n a pas de titre, sans lever", async () => {
    mockFetch(() => ok({ author_name: "LuisFonsiVEVO" }));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({
      ok: true, title: null, channelTitle: "LuisFonsiVEVO", thumbnailUrl: null,
    });
  });

  it("rend un refus sur un statut non conforme (R14)", async () => {
    // Mesure de U3: un identifiant invalide rend 400, une video valide rend 200.
    for (const code of [400, 401, 403, 404]) {
      mockFetch(status(code));
      await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({ ok: false, reason: "refused" });
    }
  });

  it("rend une panne, pas un refus, quand YouTube est en panne (R14)", async () => {
    // Un 5xx ou un 429 traites comme des refus feraient disparaitre de l historique
    // tous les morceaux ajoutes pendant une panne. R4 veut l inverse.
    for (const code of [429, 500, 502, 503]) {
      mockFetch(status(code));
      await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("rend une panne quand le reseau echoue, sans lever", async () => {
    mockFetch(() => Promise.reject(new Error("reseau")));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("rend une panne quand le delai est depasse", async () => {
    mockFetch((...args: unknown[]) => new Promise<Response>((_, reject) => {
      const signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new Error("delai depasse")));
    }));
    await expect(fetchVideoInfo("kJQP7kiw5Fk", 5)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("rend une panne quand la reponse est illisible", async () => {
    mockFetch(() => Promise.resolve(new Response("<html>pas du json</html>", { status: 200 })));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("rend une panne quand le payload n est pas un objet", async () => {
    mockFetch(() => ok(["pas", "un", "objet"]));
    await expect(fetchVideoInfo("kJQP7kiw5Fk")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("recuperation groupee (U3, envoi de playlist)", () => {
  it("interroge chaque morceau une fois et rend chaque resultat a son rang", async () => {
    const seen: string[] = [];
    mockFetch((...args: unknown[]) => {
      const url = String(args[0]);
      seen.push(url);
      return ok({ title: url.includes("aaaaaaaaaaa") ? "Premier" : "Second" });
    });

    const rendus: Array<[number, string | null]> = [];
    await fetchEachVideoInfo(["aaaaaaaaaaa", "bbbbbbbbbbb"], (index, outcome) => {
      rendus.push([index, outcome.ok ? outcome.title : null]);
    });

    expect(seen).toHaveLength(2);
    expect(rendus.sort((a, b) => a[0] - b[0])).toEqual([[0, "Premier"], [1, "Second"]]);
  });

  it("ne lance jamais plus de requetes simultanees que le plafond", async () => {
    let enCours = 0;
    let pic = 0;
    const attente: Array<() => void> = [];
    mockFetch(() => {
      enCours += 1;
      pic = Math.max(pic, enCours);
      return new Promise<Response>((resolve) => {
        attente.push(() => {
          enCours -= 1;
          resolve(new Response(JSON.stringify({ title: "x" }), { status: 200 }));
        });
      });
    });

    const ids = Array.from({ length: 9 }, (_, i) => `video${String(i).padStart(6, "0")}`);
    const run = fetchEachVideoInfo(ids, () => {}, 3);
    for (let done = 0; done < ids.length; done++) {
      await tick();
      const release = attente.shift();
      expect(release).toBeDefined();
      release?.();
    }
    await run;

    expect(pic).toBe(3);
  });

  it("ne rend rien et n interroge personne sur une liste vide", async () => {
    mockFetch(() => ok(REPONSE_UTILE));
    const rendus: number[] = [];
    await fetchEachVideoInfo([], (index) => rendus.push(index));
    expect(rendus).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rend aussi les refus et les pannes, sans interrompre les autres (R4, R14)", async () => {
    mockFetch((...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("aaaaaaaaaaa")) return Promise.resolve(new Response("", { status: 400 }));
      if (url.includes("bbbbbbbbbbb")) return Promise.reject(new Error("reseau"));
      return ok(REPONSE_UTILE);
    });

    const rendus = new Map<number, string>();
    await fetchEachVideoInfo(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"], (index, outcome) => {
      rendus.set(index, outcome.ok ? "ok" : outcome.reason);
    });

    expect([...rendus.entries()].sort((a, b) => a[0] - b[0]))
      .toEqual([[0, "refused"], [1, "unavailable"], [2, "ok"]]);
  });
});
