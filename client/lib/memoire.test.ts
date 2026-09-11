import { describe, it, expect, vi, afterEach } from "vitest";
import { ajouterPage, fetchStats, type Stats } from "./memoire";

function repond(status: number, payload: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status })));
}

afterEach(() => vi.unstubAllGlobals());

const CLASSEMENT_VIDE = { entries: [], coveredPlays: 0, distinctCount: 0 };

/** L etat du jour un: trois lignes, trois seances, aucune duree, aucun artiste (U8). */
const JOUR_UN = {
  totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 3, sessionCount: 3 },
  topTracks: CLASSEMENT_VIDE,
  topArtists: CLASSEMENT_VIDE,
  topGenres: CLASSEMENT_VIDE,
  sessions: {
    entries: [{
      roomInstanceId: "i5c2a16b451fb",
      startedAt: 1_700_000_000_000,
      trackCount: 1,
      listenedMs: 0,
      tracks: [{
        videoId: "kJQP7kiw5Fk", title: "Despacito", channelTitle: null,
        thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/default.jpg",
        genres: null, playedAt: 1_700_000_000_000, listenedMs: null,
      }],
    }],
    nextBefore: null,
  },
};

describe("lecture des statistiques", () => {
  it("rend les compteurs, les classements et les seances tels que la route les donne", async () => {
    repond(200, JOUR_UN);
    const stats = await fetchStats();
    expect(stats?.totals).toEqual({ listenedMs: 0, timedTrackCount: 0, trackCount: 3, sessionCount: 3 });
    expect(stats?.sessions.entries).toHaveLength(1);
    expect(stats?.sessions.entries[0]?.tracks[0]?.title).toBe("Despacito");
  });

  it("garde null comme duree non mesuree, jamais zero", async () => {
    repond(200, JOUR_UN);
    const stats = await fetchStats();
    expect(stats?.sessions.entries[0]?.tracks[0]?.listenedMs).toBeNull();
  });

  it("ne porte ni miniature ni genres jusqu a l ecran: il n a pas a les afficher", async () => {
    repond(200, JOUR_UN);
    const piste = (await fetchStats())?.sessions.entries[0]?.tracks[0];
    expect(piste).not.toHaveProperty("thumbnailUrl");
    expect(piste).not.toHaveProperty("genres");
  });

  it("passe le curseur de seance en parametre", async () => {
    let demandee: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      demandee = url;
      return new Response(JSON.stringify(JOUR_UN), { status: 200 });
    }));
    await fetchStats("1700000000000.i5c2a16b451fb");
    expect(demandee).toBe("/api/stats?before=1700000000000.i5c2a16b451fb");
  });

  it("rend rien du tout sur 401, l invite n ayant pas de memoire", async () => {
    repond(401, { error: "connexion requise" });
    expect(await fetchStats()).toBeNull();
  });

  it("rend rien du tout quand les compteurs manquent: mieux vaut attendre que zeroter", async () => {
    repond(200, { sessions: { entries: [], nextBefore: null } });
    expect(await fetchStats()).toBeNull();
  });

  it("rend rien du tout quand le serveur est injoignable, sans lever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("reseau"); }));
    expect(await fetchStats()).toBeNull();
  });

  it("saute une entree illisible plutot que de l inventer", async () => {
    repond(200, {
      totals: { listenedMs: 1000, timedTrackCount: 1, trackCount: 1, sessionCount: 1 },
      topTracks: { entries: [{ title: "sans identifiant" }, { videoId: "ok", title: null }], coveredPlays: 1, distinctCount: 1 },
      sessions: { entries: [{ startedAt: 1 }, JOUR_UN.sessions.entries[0]], nextBefore: null },
    });
    const stats = await fetchStats();
    expect(stats?.topTracks.entries).toHaveLength(1);
    expect(stats?.topTracks.entries[0]?.videoId).toBe("ok");
    expect(stats?.sessions.entries).toHaveLength(1);
  });

  it("rend des classements vides quand la route n en donne aucun", async () => {
    repond(200, { totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 0, sessionCount: 0 } });
    const stats = await fetchStats();
    expect(stats?.topGenres).toEqual(CLASSEMENT_VIDE);
    expect(stats?.sessions).toEqual({ entries: [], nextBefore: null });
  });
});

describe("page de seances suivante", () => {
  const page = (ids: string[], nextBefore: string | null): Stats => ({
    totals: { listenedMs: 60_000, timedTrackCount: 1, trackCount: 2, sessionCount: 4 },
    topTracks: CLASSEMENT_VIDE, topArtists: CLASSEMENT_VIDE, topGenres: CLASSEMENT_VIDE,
    sessions: {
      entries: ids.map((id) => ({
        roomInstanceId: id, startedAt: 1, trackCount: 0, listenedMs: 0, tracks: [],
      })),
      nextBefore,
    },
  });

  it("ajoute les seances a la suite et reprend le curseur de la nouvelle page", () => {
    const fusion = ajouterPage(page(["a", "b"], "curseur"), page(["c"], null));
    expect(fusion.sessions.entries.map((s) => s.roomInstanceId)).toEqual(["a", "b", "c"]);
    expect(fusion.sessions.nextBefore).toBeNull();
  });

  it("garde les compteurs de la premiere page: ils ne parlent pas de la page affichee", () => {
    const premiere = page(["a"], "curseur");
    const seconde = page(["b"], null);
    seconde.totals.trackCount = 99;
    expect(ajouterPage(premiere, seconde).totals.trackCount).toBe(2);
  });

  // Deux clics sur "Voir plus" avant que la reponse arrive rejouent la meme page:
  // sans dedoublonnage, les seances de la page se retrouvent deux fois (revue du
  // 11/09/2026, #5).
  it("la meme page appliquee deux fois ne duplique aucune seance", () => {
    const precedent = page(["a", "b"], "curseur");
    const suivant = page(["c", "d"], "curseur2");
    const uneFois = ajouterPage(precedent, suivant);
    const deuxFois = ajouterPage(uneFois, suivant);
    expect(deuxFois.sessions.entries.map((s) => s.roomInstanceId)).toEqual(["a", "b", "c", "d"]);
  });

  // Une reponse en retard (l ecran a recharge ses stats entre-temps) peut chevaucher
  // la page deja affichee: chaque seance ne doit rester qu une fois, dans l ordre
  // (revue du 11/09/2026, #5).
  it("une page qui chevauche la precedente ne garde chaque seance qu une fois, dans l ordre", () => {
    const precedent = page(["a", "b", "c"], "curseur");
    const suivant = page(["c", "d"], null);
    const fusion = ajouterPage(precedent, suivant);
    expect(fusion.sessions.entries.map((s) => s.roomInstanceId)).toEqual(["a", "b", "c", "d"]);
    expect(fusion.sessions.nextBefore).toBeNull();
  });

  it("une page sans recouvrement s ajoute telle quelle", () => {
    const precedent = page(["a"], "curseur");
    const suivant = page(["b", "c"], "curseur2");
    const fusion = ajouterPage(precedent, suivant);
    expect(fusion.sessions.entries.map((s) => s.roomInstanceId)).toEqual(["a", "b", "c"]);
    expect(fusion.sessions.nextBefore).toBe("curseur2");
  });
});
