import { describe, it, expect, vi } from "vitest";
import { openDatabase, type Db } from "./db";
import {
  createGenreFiller, fetchVideoTopics, fillMissingGenres, parseTopicsResponse,
} from "./videoTopics";
import { mockFetch, restoreFetchAfterEach, jsonOk as ok, httpStatus as status } from "./mockFetch";

restoreFetchAfterEach();

const T0 = 1_700_000_000_000;
const WIKI = "https://en.wikipedia.org/wiki/";
const CLEF = "clef-de-test";

/*
 * Forme reelle de la reponse, relevee sur videos.list?part=topicDetails le 09/09/2026:
 * les categories arrivent en adresses d articles Wikipedia, jamais en etiquettes.
 */
function item(id: string, ...categories: unknown[]) {
  return { kind: "youtube#video", id, topicDetails: { topicCategories: categories } };
}

/*
 * Remplace `fetch` et rend le tableau des lots demandes, un tableau d identifiants par
 * requete: c est ce qui rend visible le decoupage en lots et l arret sur quota.
 */
function captureFetch(reply: (ids: string[], call: number) => Promise<Response>): string[][] {
  const calls: string[][] = [];
  mockFetch((...args: unknown[]) => {
    const raw = new URL(String(args[0])).searchParams.get("id") ?? "";
    const ids = raw.split(",").filter((id) => id.length > 0);
    calls.push(ids);
    return reply(ids, calls.length - 1);
  });
  return calls;
}

/** Un identifiant de la forme de ceux de YouTube: onze caracteres. */
function videoId(index: number): string {
  return `vid${String(index).padStart(8, "0")}`;
}

/*
 * Une base en memoire portant `count` videos jamais interrogees, la derniere etant la
 * plus recemment jouee. Deux ecoutes du meme morceau ne sont pas la meme video: c est
 * le point de KTD5, un appel couvre toutes les lignes qui partagent l identifiant.
 */
function dbWithVideos(count: number): { db: Db; user: number } {
  const db = openDatabase(":memory:");
  const user = db.upsertUser({ googleSub: "sub-leo", name: "Leopold", email: null }, T0).id;
  for (let i = 0; i < count; i += 1) {
    db.recordListen({
      userId: user,
      videoId: videoId(i),
      title: `Morceau ${i}`,
      roomItemKey: `inst-1#i${i}`,
      roomInstanceId: "inst-1",
    }, T0 + i);
  }
  return { db, user };
}

/** Les genres de chaque video, par identifiant, tels que la base les relit. */
function genresByVideo(db: Db, user: number): Map<string, string[] | null> {
  const byVideo = new Map<string, string[] | null>();
  for (const entry of db.listHistory(user, 500)) byVideo.set(entry.videoId, entry.genres);
  return byVideo;
}

describe("lecture d une reponse de categories", () => {
  it("rend les genres normalises et ecarte l etiquette generique", () => {
    // Reponse mesuree sur Despacito le 09/09/2026, adresses comprises.
    const topics = parseTopicsResponse({
      items: [item(
        "kJQP7kiw5Fk",
        `${WIKI}Electronic_music`,
        `${WIKI}Music`,
        `${WIKI}Music_of_Latin_America`,
        `${WIKI}Pop_music`,
      )],
    });
    expect(topics).toEqual([{
      videoId: "kJQP7kiw5Fk",
      genres: ["Electronic music", "Music of Latin America", "Pop music"],
    }]);
  });

  /*
   * AE8, KTD12. Une video sans categorie est « interrogee, aucun genre »: elle recoit
   * un tableau vide, pas l absence de reponse, sinon elle serait redemandee a YouTube
   * a chaque ouverture de l ecran.
   */
  it("marque interrogee une video sans categorie, en rendant un tableau vide (AE8)", () => {
    const topics = parseTopicsResponse({
      items: [
        item("kJQP7kiw5Fk"),
        { kind: "youtube#video", id: "dQw4w9WgXcQ" },
        { kind: "youtube#video", id: "9bZkp7q19f0", topicDetails: {} },
      ],
    });
    expect(topics).toEqual([
      { videoId: "kJQP7kiw5Fk", genres: [] },
      { videoId: "dQw4w9WgXcQ", genres: [] },
      { videoId: "9bZkp7q19f0", genres: [] },
    ]);
  });

  it("rend une video interrogee sans genre quand il ne reste que l etiquette generique", () => {
    const topics = parseTopicsResponse({ items: [item("kJQP7kiw5Fk", `${WIKI}Music`)] });
    expect(topics).toEqual([{ videoId: "kJQP7kiw5Fk", genres: [] }]);
  });

  it("rend les etiquettes d une video non musicale sans lever", () => {
    const topics = parseTopicsResponse({
      items: [item("kJQP7kiw5Fk", `${WIKI}Humour`, `${WIKI}Lifestyle_(sociology)`)],
    });
    expect(topics[0]?.genres).toEqual(["Humour", "Lifestyle (sociology)"]);
  });

  it("ignore une adresse d article de forme inattendue sans perdre les autres", () => {
    const topics = parseTopicsResponse({
      items: [item(
        "kJQP7kiw5Fk",
        "pas une adresse",
        "https://example.com/wiki/Pop_music",
        WIKI,
        `${WIKI}%E0%A4%A`, // echappement invalide: aucune etiquette lisible a en tirer
        42,
        `${WIKI}Rock_music`,
      )],
    });
    expect(topics[0]?.genres).toEqual(["Rock music"]);
  });

  it("decode un titre d article echappe", () => {
    const topics = parseTopicsResponse({ items: [item("kJQP7kiw5Fk", `${WIKI}Rock_%27n%27_roll`)] });
    expect(topics[0]?.genres).toEqual(["Rock 'n' roll"]);
  });

  it("laisse de cote l ancre et les parametres d une adresse", () => {
    const topics = parseTopicsResponse({
      items: [item("kJQP7kiw5Fk", `${WIKI}Pop_music#Origins`, `${WIKI}Jazz?action=raw`)],
    });
    expect(topics[0]?.genres).toEqual(["Pop music", "Jazz"]);
  });

  it("dedoublonne deux adresses qui donnent la meme etiquette", () => {
    const topics = parseTopicsResponse({
      items: [item("kJQP7kiw5Fk", `${WIKI}Pop_music`, `${WIKI}Pop_music`)],
    });
    expect(topics[0]?.genres).toEqual(["Pop music"]);
  });

  it("ignore un item malforme sans perdre les autres", () => {
    const topics = parseTopicsResponse({
      items: [
        { kind: "youtube#video", topicDetails: { topicCategories: [`${WIKI}Pop_music`] } },
        item("kJQP7kiw5Fk", `${WIKI}Rock_music`),
      ],
    });
    expect(topics).toEqual([{ videoId: "kJQP7kiw5Fk", genres: ["Rock music"] }]);
  });

  it("rend une liste vide sur une reponse illisible plutot que de lever", () => {
    expect(parseTopicsResponse(null)).toEqual([]);
    expect(parseTopicsResponse({})).toEqual([]);
    expect(parseTopicsResponse({ items: "pas un tableau" })).toEqual([]);
  });
});

describe("appel des categories a l API", () => {
  it("demande les topicDetails des identifiants voulus, avec la clef", async () => {
    let seen = "";
    mockFetch((...args: unknown[]) => {
      seen = String(args[0]);
      return ok({ items: [] });
    });
    await fetchVideoTopics(["kJQP7kiw5Fk", "dQw4w9WgXcQ"], CLEF);

    const url = new URL(seen);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("topicDetails");
    expect(url.searchParams.get("id")).toBe("kJQP7kiw5Fk,dQw4w9WgXcQ");
    expect(url.searchParams.get("key")).toBe(CLEF);
  });

  it("rend les genres d une reponse utile", async () => {
    mockFetch(() => ok({ items: [item("kJQP7kiw5Fk", `${WIKI}Pop_music`)] }));
    await expect(fetchVideoTopics(["kJQP7kiw5Fk"], CLEF)).resolves.toEqual({
      ok: true,
      topics: [{ videoId: "kJQP7kiw5Fk", genres: ["Pop music"] }],
    });
  });

  it("distingue un quota epuise d une panne", async () => {
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }),
      { status: 403 },
    )));
    await expect(fetchVideoTopics(["kJQP7kiw5Fk"], CLEF)).resolves.toEqual({ ok: false, reason: "quota" });

    // Un 403 pour une cle mal restreinte n est pas un quota: il ne repart pas demain.
    mockFetch(() => Promise.resolve(new Response(
      JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }),
      { status: 403 },
    )));
    await expect(fetchVideoTopics(["kJQP7kiw5Fk"], CLEF)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("rend une panne sur un statut d erreur ou un reseau coupe", async () => {
    for (const code of [400, 404, 500, 503]) {
      mockFetch(status(code));
      await expect(fetchVideoTopics(["kJQP7kiw5Fk"], CLEF)).resolves.toEqual({ ok: false, reason: "unavailable" });
    }
    mockFetch(() => Promise.reject(new Error("reseau coupe")));
    await expect(fetchVideoTopics(["kJQP7kiw5Fk"], CLEF)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("ne demande rien pour une liste vide: une requete vide couterait une unite", async () => {
    const calls = captureFetch(() => ok({ items: [] }));
    await expect(fetchVideoTopics([], CLEF)).resolves.toEqual({ ok: true, topics: [] });
    expect(calls).toHaveLength(0);
  });
});

/*
 * U6, KTD5. Le remplissage se fait par lots sur les lignes deja enregistrees, jamais
 * au moment d ajouter un morceau: le chemin de la room reste intact et l existant se
 * rattrape par construction.
 */
describe("remplissage des genres par lots (U6)", () => {
  it("remplit les lignes sans genre, y compris celles deja en base (R11)", async () => {
    const { db, user } = dbWithVideos(2);
    // Deuxieme ecoute du premier morceau: le genre est une propriete de la video.
    db.recordListen({
      userId: user, videoId: videoId(0), title: "Morceau 0",
      roomItemKey: "inst-2#i0", roomInstanceId: "inst-2",
    }, T0 + 100);

    const calls = captureFetch((ids) => ok({
      items: ids.map((id) => item(id, `${WIKI}Pop_music`, `${WIKI}Music`)),
    }));
    await fillMissingGenres({ db, apiKey: CLEF });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    const genres = db.listHistory(user, 10).map((entry) => entry.genres);
    expect(genres).toEqual([["Pop music"], ["Pop music"], ["Pop music"]]);
    db.close();
  });

  it("marque interrogee une video sans genre et ne la redemande pas au passage suivant (AE8)", async () => {
    const { db, user } = dbWithVideos(1);
    const premier = captureFetch((ids) => ok({ items: ids.map((id) => item(id)) }));
    await fillMissingGenres({ db, apiKey: CLEF });
    expect(premier).toHaveLength(1);
    expect(genresByVideo(db, user).get(videoId(0))).toEqual([]);

    const second = captureFetch(() => ok({ items: [] }));
    await fillMissingGenres({ db, apiKey: CLEF });
    expect(second).toHaveLength(0);
    db.close();
  });

  it("decoupe un historique de plus de cinquante videos en plusieurs requetes", async () => {
    const { db } = dbWithVideos(60);
    const calls = captureFetch((ids) => ok({ items: ids.map((id) => item(id, `${WIKI}Pop_music`)) }));
    await fillMissingGenres({ db, apiKey: CLEF });

    expect(calls.map((ids) => ids.length)).toEqual([50, 10]);
    expect(new Set(calls.flat()).size).toBe(60);
    db.close();
  });

  it("ecrit ce qui est revenu d une reponse partielle et laisse le reste a traiter", async () => {
    const { db, user } = dbWithVideos(2);
    captureFetch(() => ok({ items: [item(videoId(0), `${WIKI}Pop_music`)] }));
    await fillMissingGenres({ db, apiKey: CLEF });

    const genres = genresByVideo(db, user);
    expect(genres.get(videoId(0))).toEqual(["Pop music"]);
    expect(genres.get(videoId(1))).toBeNull();

    // La video absente de la reponse revient au passage suivant, elle reste a NULL.
    const suivant = captureFetch((ids) => ok({ items: ids.map((id) => item(id, `${WIKI}Rock_music`)) }));
    await fillMissingGenres({ db, apiKey: CLEF });
    expect(suivant).toEqual([[videoId(1)]]);
    expect(genresByVideo(db, user).get(videoId(1))).toEqual(["Rock music"]);
    db.close();
  });

  it("n ecrit rien sur un quota epuise et ne demande pas le lot suivant", async () => {
    const { db, user } = dbWithVideos(60);
    const calls = captureFetch(() => Promise.resolve(new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }),
      { status: 403 },
    )));
    await fillMissingGenres({ db, apiKey: CLEF });

    // Reessayer n y changera rien avant demain: le second lot n est meme pas demande.
    expect(calls).toHaveLength(1);
    expect([...genresByVideo(db, user).values()].every((genres) => genres === null)).toBe(true);
    db.close();
  });

  it("passe au lot suivant sur une panne reseau, contrairement au quota", async () => {
    const { db, user } = dbWithVideos(60);
    const calls = captureFetch((ids, call) => (
      call === 0
        ? Promise.reject(new Error("reseau coupe"))
        : ok({ items: ids.map((id) => item(id, `${WIKI}Pop_music`)) })
    ));
    await fillMissingGenres({ db, apiKey: CLEF });

    expect(calls).toHaveLength(2);
    const genres = genresByVideo(db, user);
    const remplies = [...genres.values()].filter((value) => value !== null);
    expect(remplies).toHaveLength(10);
    db.close();
  });

  it("n efface aucun genre deja ecrit quand la reponse est illisible", async () => {
    const { db, user } = dbWithVideos(2);
    db.setVideoGenres(videoId(0), ["Pop music"]);

    const calls = captureFetch(() => ok({ items: "pas un tableau" }));
    await fillMissingGenres({ db, apiKey: CLEF });

    expect(calls).toEqual([[videoId(1)]]);
    const genres = genresByVideo(db, user);
    expect(genres.get(videoId(0))).toEqual(["Pop music"]);
    expect(genres.get(videoId(1))).toBeNull();
    db.close();
  });

  it("borne le nombre de lots par declenchement et laisse le reste pour le passage suivant", async () => {
    const { db, user } = dbWithVideos(120);
    const calls = captureFetch((ids) => ok({ items: ids.map((id) => item(id, `${WIKI}Pop_music`)) }));
    await fillMissingGenres({ db, apiKey: CLEF, maxBatches: 2 });

    expect(calls.map((ids) => ids.length)).toEqual([50, 50]);
    const restantes = [...genresByVideo(db, user).values()].filter((genres) => genres === null);
    expect(restantes).toHaveLength(20);

    await fillMissingGenres({ db, apiKey: CLEF, maxBatches: 2 });
    expect(calls.map((ids) => ids.length)).toEqual([50, 50, 20]);
    db.close();
  });

  it("ne demande rien quand aucune ligne n attend de genre", async () => {
    const { db } = dbWithVideos(0);
    const calls = captureFetch(() => ok({ items: [] }));
    await fillMissingGenres({ db, apiKey: CLEF });
    expect(calls).toHaveLength(0);
    db.close();
  });

  /*
   * Revue du 11/09/2026, #4. La route de statistiques lance ce remplissage sans
   * l attendre: un rejet n y serait rattrape par personne, et Node arrete alors le
   * process, toutes les rooms avec. Une base verrouillee (SQLITE_BUSY) ou un disque
   * plein doivent finir en une ligne de log, jamais en rejet.
   */
  it("se resout sans rejeter quand la lecture des videos a interroger leve (revue #4)", async () => {
    const { db } = dbWithVideos(1);
    vi.spyOn(db, "listVideoIdsWithoutGenres").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = captureFetch(() => ok({ items: [] }));

    await expect(fillMissingGenres({ db, apiKey: CLEF })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    // Une ligne, jamais l objet d erreur: son contexte peut porter un secret.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.any(String));
    db.close();
  });

  it("se resout sans rejeter quand l ecriture des genres leve (revue #4)", async () => {
    const { db } = dbWithVideos(2);
    vi.spyOn(db, "setVideoGenres").mockImplementation(() => {
      throw new Error("database or disk is full");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = captureFetch((ids) => ok({ items: ids.map((id) => item(id, `${WIKI}Pop_music`)) }));

    await expect(fillMissingGenres({ db, apiKey: CLEF })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.any(String));
    db.close();
  });
});

/*
 * Revue du 11/09/2026, #8. Le remplissage part de la route de statistiques, que tout
 * compte Google peut recharger en boucle, et une video que YouTube ne rend plus reste a
 * NULL: chaque passage la redemande. La borne de lots par passage ne suffit donc pas,
 * le declencheur borne aussi la cadence des passages.
 */
describe("cadence du remplissage des genres (revue #8)", () => {
  const TEN_MINUTES = 10 * 60_000;

  it("ne lance qu un passage pour cent declenchements rapproches", async () => {
    // YouTube ne rend jamais cette video: sans borne, chaque declenchement la redemande.
    const { db } = dbWithVideos(1);
    const calls = captureFetch(() => ok({ items: [] }));
    let clock = T0;
    const filler = createGenreFiller({ db, apiKey: CLEF, minIntervalMs: TEN_MINUTES, now: () => clock });

    for (let i = 0; i < 100; i += 1) {
      await filler.trigger();
      clock += 1_000;
    }
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("ignore un declenchement pendant qu un passage est en cours", async () => {
    const { db } = dbWithVideos(1);
    let release: () => void = () => {};
    const calls = captureFetch((_ids, call) => (
      call === 0
        ? new Promise<Response>((resolve) => { release = () => resolve(ok({ items: [] })); })
        : ok({ items: [] })
    ));
    // Intervalle nul: seul le passage en cours peut refuser un declenchement ici.
    const filler = createGenreFiller({ db, apiKey: CLEF, minIntervalMs: 0, now: () => T0 });

    const first = filler.trigger();
    await filler.trigger();
    expect(calls).toHaveLength(1);

    release();
    await first;
    await filler.trigger();
    expect(calls).toHaveLength(2);
    db.close();
  });

  it("relance un passage une fois l intervalle ecoule", async () => {
    const { db } = dbWithVideos(1);
    const calls = captureFetch(() => ok({ items: [] }));
    let clock = T0;
    const filler = createGenreFiller({ db, apiKey: CLEF, minIntervalMs: TEN_MINUTES, now: () => clock });

    await filler.trigger();
    clock += TEN_MINUTES - 1;
    await filler.trigger();
    expect(calls).toHaveLength(1);

    clock += 1;
    await filler.trigger();
    expect(calls).toHaveLength(2);
    db.close();
  });

  it("libere le passage en cours meme quand il echoue", async () => {
    const { db } = dbWithVideos(1);
    vi.spyOn(db, "listVideoIdsWithoutGenres").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = captureFetch(() => ok({ items: [] }));
    const filler = createGenreFiller({ db, apiKey: CLEF, minIntervalMs: 0, now: () => T0 });

    await filler.trigger();
    expect(calls).toHaveLength(0);
    // Reste marque en cours, le remplissage serait eteint jusqu au redemarrage du serveur.
    await filler.trigger();
    expect(calls).toHaveLength(1);
    db.close();
  });
});
