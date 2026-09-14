import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db, type User } from "./db";
import { recordCommonStart, recordPlayedSegment } from "./history";
import { createRoom, type RoomSnapshot } from "./room";
import { createRegistry } from "./roomRegistry";
import { fetchEachVideoInfo } from "./videoInfo";
import { mockFetch, restoreFetchAfterEach, jsonOk as oembed } from "./mockFetch";

const T0 = 1_700_000_000_000;

const CFG = { maxParticipants: 2, maxWaitMs: 45_000, leadMs: 500, graceMs: 30_000, maxQueue: 100 };

function item(over: Partial<RoomSnapshot["queue"][number]> = {}): RoomSnapshot["queue"][number] {
  return {
    itemId: "q1", videoId: "kJQP7kiw5Fk", addedBy: "p1", title: "Despacito",
    channelTitle: null, thumbnailUrl: null, refused: false,
    ...over,
  };
}

function snapshot(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    code: "ABCD",
    participants: [],
    queue: [item()],
    currentItemId: "q1",
    playing: true,
    ...over,
  };
}

restoreFetchAfterEach();

/*
 * Le meme raccordement que le transport (server/index.ts): oEmbed rend, la room pose,
 * le depart commun ecrit. Reproduit ici parce que index.ts ouvre un serveur des son
 * import et ne se teste pas; c est le seul endroit ou les trois modules se rencontrent
 * sur les deux chemins d ajout (U3).
 */
async function fillQueueInfo(
  room: ReturnType<typeof createRoom>,
  entries: Array<{ itemId: string; videoId: string }>,
): Promise<void> {
  await fetchEachVideoInfo(entries.map((e) => e.videoId), (index, outcome) => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (outcome.ok) room.setInfo(entry.itemId, outcome);
    else if (outcome.reason === "refused") room.markRefused(entry.itemId);
  });
}

describe("historique au depart commun", () => {
  let db: Db;
  let leo: User;

  beforeEach(() => {
    db = openDatabase(":memory:");
    leo = db.upsertUser({ googleSub: "sub-leo", name: "Leo", email: null }, T0);
  });

  afterEach(() => db.close());

  it("enregistre une entree pour chaque participant connecte", () => {
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0);
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo, ami], nowMs: T0 });

    expect(db.listHistory(leo.id, 10)).toHaveLength(1);
    expect(db.listHistory(ami.id, 10)).toHaveLength(1);
  });

  it("un invite ne laisse aucune trace (AE1, R10)", () => {
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo, null], nowMs: T0 });
    expect(db.listHistory(leo.id, 10)).toHaveLength(1);
  });

  it("trois departs du meme morceau ne font qu une entree (AE5)", () => {
    for (const at of [T0, T0 + 5_000, T0 + 9_000]) {
      recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo], nowMs: at });
    }
    const entries = db.listHistory(leo.id, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.playedAt).toBe(T0); // la premiere ecoute fait foi
  });

  it("un participant absent d un depart n y gagne rien (AE2)", () => {
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [], nowMs: T0 });
    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
  });

  it("n ecrit rien sans morceau courant", () => {
    recordCommonStart({
      db, instanceId: "i1", snapshot: snapshot({ currentItemId: null }), users: [leo], nowMs: T0,
    });
    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
  });

  it("garde un titre null quand la queue ne le connait pas encore", () => {
    recordCommonStart({
      db,
      instanceId: "i1",
      snapshot: snapshot({ queue: [item({ title: null })] }),
      users: [leo],
      nowMs: T0,
    });
    expect(db.listHistory(leo.id, 10)[0]?.title).toBeNull();
  });

  it("le meme morceau dans deux instances de room fait deux entrees (KTD6)", () => {
    // Le code a quatre lettres peut etre le meme: seule l instance compte.
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo], nowMs: T0 });
    recordCommonStart({ db, instanceId: "i2", snapshot: snapshot(), users: [leo], nowMs: T0 + 60_000 });
    expect(db.listHistory(leo.id, 10)).toHaveLength(2);
  });

  it("inscrit l instance de room sur la ligne, sans la redecouper de la cle (KTD4)", () => {
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo], nowMs: T0 });
    expect(db.listHistory(leo.id, 10)[0]?.roomInstanceId).toBe("i1");
  });

  it("reporte le nom de chaine et la miniature de la file (R2, R3)", () => {
    recordCommonStart({
      db,
      instanceId: "i1",
      snapshot: snapshot({
        queue: [item({
          channelTitle: "LuisFonsiVEVO",
          thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
        })],
      }),
      users: [leo],
      nowMs: T0,
    });
    expect(db.listHistory(leo.id, 10)[0]).toMatchObject({
      channelTitle: "LuisFonsiVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    });
  });

  it("n ecrit aucune ligne pour un morceau refuse par YouTube (AE11, R14)", () => {
    recordCommonStart({
      db,
      instanceId: "i1",
      snapshot: snapshot({ queue: [item({ title: null, refused: true })] }),
      users: [leo],
      nowMs: T0,
    });
    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
  });

  it("ecrit la ligne d un morceau dont oEmbed est tombe en panne, sans artiste (AE3, R4)", () => {
    // Une panne n est pas un refus: le morceau reste jouable et s enregistre.
    recordCommonStart({
      db,
      instanceId: "i1",
      snapshot: snapshot({ queue: [item({ title: null })] }),
      users: [leo],
      nowMs: T0,
    });
    expect(db.listHistory(leo.id, 10)[0]).toMatchObject({
      videoId: "kJQP7kiw5Fk", title: null, channelTitle: null, thumbnailUrl: null,
    });
  });
});

describe("de l ajout a la ligne d historique (U3)", () => {
  let db: Db;
  let leo: User;

  beforeEach(() => {
    db = openDatabase(":memory:");
    leo = db.upsertUser({ googleSub: "sub-leo", name: "Leo", email: null }, T0);
  });

  afterEach(() => db.close());

  it("un morceau ajoute un par un arrive en base avec son nom de chaine (R2)", async () => {
    mockFetch(() => oembed({
      title: "Despacito",
      author_name: "LuisFonsiVEVO",
      thumbnail_url: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    }));

    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    const added = room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    if (!added.ok) return expect.unreachable("l ajout aurait du reussir");
    await fillQueueInfo(room, [{ itemId: added.itemId, videoId: "kJQP7kiw5Fk" }]);

    room.control("play", T0 + 10);
    recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users: [leo], nowMs: T0 + 20 });

    expect(db.listHistory(leo.id, 10)[0]).toMatchObject({
      videoId: "kJQP7kiw5Fk",
      title: "Despacito",
      channelTitle: "LuisFonsiVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    });
  });

  it("un envoi de playlist interroge chaque morceau et chaque ligne porte sa chaine (R2)", async () => {
    const chaines: Record<string, string> = {
      aaaaaaaaaaa: "Chaine A", bbbbbbbbbbb: "Chaine B", ccccccccccc: "Chaine C",
    };
    mockFetch((...args: unknown[]) => {
      const url = String(args[0]);
      const found = Object.entries(chaines).find(([videoId]) => url.includes(videoId));
      const chaine = found?.[1] ?? "inconnue";
      return oembed({ title: `Titre de ${chaine}`, author_name: chaine });
    });

    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    const videoIds = Object.keys(chaines);
    // La playlist arrive avec ses titres, jamais avec son artiste (KTD6): c est oEmbed
    // qui le rend, et qui rafraichit au passage un titre stocke devenu perime.
    const sent = room.queueAddAll("leo", videoIds.map((videoId) => ({ videoId, title: "Titre stocke" })), T0);
    if (!sent.ok) return expect.unreachable("l envoi aurait du reussir");
    await fillQueueInfo(room, sent.added);

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    // Chaque morceau part a son tour: un depart commun, une ligne.
    for (let i = 0; i < videoIds.length; i++) {
      room.control(i === 0 ? "play" : "next", T0 + 100 + i);
      recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users: [leo], nowMs: T0 + 100 + i });
    }

    const lignes = db.listHistory(leo.id, 10).reverse();
    expect(lignes.map((e) => e.videoId)).toEqual(videoIds);
    expect(lignes.map((e) => e.channelTitle)).toEqual(["Chaine A", "Chaine B", "Chaine C"]);
    expect(lignes.map((e) => e.title))
      .toEqual(["Titre de Chaine A", "Titre de Chaine B", "Titre de Chaine C"]);
  });

  it("un morceau refuse par YouTube ne laisse aucune ligne, les autres si (AE11, R14)", async () => {
    mockFetch((...args: unknown[]) => String(args[0]).includes("aaaaaaaaaaa")
      ? Promise.resolve(new Response("", { status: 400 }))
      : oembed({ title: "Vivante", author_name: "Chaine B" }));

    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    const videoIds = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
    const sent = room.queueAddAll("leo", videoIds.map((videoId) => ({ videoId, title: null })), T0);
    if (!sent.ok) return expect.unreachable("l envoi aurait du reussir");
    await fillQueueInfo(room, sent.added);

    for (let i = 0; i < videoIds.length; i++) {
      room.control(i === 0 ? "play" : "next", T0 + 100 + i);
      recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users: [leo], nowMs: T0 + 100 + i });
    }

    expect(db.listHistory(leo.id, 10).map((e) => e.videoId)).toEqual(["bbbbbbbbbbb"]);
  });

  it("une panne d oEmbed laisse la ligne s ecrire sans artiste (AE3, R4)", async () => {
    mockFetch(() => Promise.reject(new Error("reseau")));

    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    const added = room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    if (!added.ok) return expect.unreachable("l ajout aurait du reussir");
    await fillQueueInfo(room, [{ itemId: added.itemId, videoId: "kJQP7kiw5Fk" }]);

    room.control("play", T0 + 10);
    recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users: [leo], nowMs: T0 + 20 });

    expect(db.listHistory(leo.id, 10)[0]).toMatchObject({
      videoId: "kJQP7kiw5Fk", title: null, channelTitle: null, thumbnailUrl: null,
    });
  });
});

/*
 * U4, R1. Le trajet complet d une duree: la room mesure avant de muter (KTD1), rend le
 * segment joue, et c est l appelant qui ecrit (KTD9). Les trois exemples d acceptation
 * sur la duree se jouent ici, seul endroit ou room et base se rencontrent.
 */
describe("duree jouee, de la room a la ligne (U4)", () => {
  let db: Db;
  let leo: User;

  beforeEach(() => {
    db = openDatabase(":memory:");
    leo = db.upsertUser({ googleSub: "sub-leo", name: "Leo", email: null }, T0);
  });

  afterEach(() => db.close());

  /** Un depart commun: la barriere s ouvre, tout le monde est pret, la ligne s ecrit. */
  function depart(
    room: ReturnType<typeof createRoom>,
    users: Array<User | null>,
    nowMs: number,
    positionMs = 0,
  ): void {
    const attente = room.resumeAt(positionMs, nowMs);
    room.ready("leo", attente.barrierId, nowMs);
    recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users, nowMs });
  }

  /*
   * Le raccordement du transport (server/index.ts, case "control_transport"): la room
   * rend le segment joue, l appelant l ecrit. Aucune session, aucun compte ne passe
   * par la.
   */
  function transport(
    room: ReturnType<typeof createRoom>,
    action: "play" | "pause" | "next" | "previous",
    nowMs: number,
  ): void {
    const played = room.control(action, nowMs);
    if (played) recordPlayedSegment({ db, instanceId: "i1", played, nowMs });
  }

  /** Deux morceaux, depart commun emis a T0 + leadMs, position 0. */
  function enLecture(users: Array<User | null>) {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.queueAdd("leo", "dQw4w9WgXcQ", T0);
    room.control("play", T0);
    depart(room, users, T0);
    return room;
  }

  const ligneDe = (videoId: string) =>
    db.listHistory(leo.id, 10).find((e) => e.videoId === videoId);

  it("compte trente secondes pour un morceau mis en pause dix minutes puis zappe (AE1, R1)", () => {
    const room = enLecture([leo]);
    const pause = T0 + CFG.leadMs + 10_000;
    transport(room, "pause", pause);
    const reprise = pause + 600_000;
    transport(room, "play", reprise);
    depart(room, [leo], reprise, 10_000);

    transport(room, "next", reprise + CFG.leadMs + 20_000);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(30_000);
  });

  it("compte dix secondes pour un morceau zappe au bout de dix secondes (AE2, R1)", () => {
    const room = enLecture([leo]);

    transport(room, "next", T0 + CFG.leadMs + 10_000);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(10_000);
  });

  it("additionne les deux passages d un morceau rappele par « precedent » (AE7, R1, KTD3)", () => {
    const room = enLecture([leo]);
    const zap = T0 + CFG.leadMs + 30_000;
    transport(room, "next", zap);
    depart(room, [leo], zap);
    const retour = zap + CFG.leadMs + 4_000;
    transport(room, "previous", retour);
    depart(room, [leo], retour);

    transport(room, "next", retour + CFG.leadMs + 20_000);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(50_000);
    expect(ligneDe("dQw4w9WgXcQ")?.listenedMs).toBe(4_000);
  });

  it("ecrit la duree sur une fin naturelle de piste comme sur un zap (R1)", () => {
    const room = enLecture([leo]);

    const fin = T0 + CFG.leadMs + 12_000;
    const outcome = room.trackEnded("q1", fin);
    if (outcome.played) recordPlayedSegment({ db, instanceId: "i1", played: outcome.played, nowMs: fin });

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(12_000);
  });

  it("ecrit la duree du dernier morceau quand le suivant vide la lecture (R7)", () => {
    const room = enLecture([leo]);
    const zap = T0 + CFG.leadMs + 10_000;
    transport(room, "next", zap);
    depart(room, [leo], zap);

    transport(room, "next", zap + CFG.leadMs + 8_000);

    expect(room.state().currentItemId).toBe(null);
    expect(ligneDe("dQw4w9WgXcQ")?.listenedMs).toBe(8_000);
  });

  it("ne laisse ni ligne ni duree pour un participant non connecte (R10)", () => {
    const room = enLecture([null]);

    transport(room, "next", T0 + CFG.leadMs + 10_000);

    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
  });

  it("porte la meme duree sur la ligne de chacun des deux comptes presents (R1)", () => {
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0);
    const room = enLecture([leo, ami]);

    transport(room, "next", T0 + CFG.leadMs + 25_000);

    expect(db.listHistory(leo.id, 10)[0]?.listenedMs).toBe(25_000);
    expect(db.listHistory(ami.id, 10)[0]?.listenedMs).toBe(25_000);
  });

  /*
   * Le piege de KTD3: les departs communs se repetent, et l ecriture au depart ne doit
   * jamais ramener a zero une duree deja mesuree.
   */
  it("garde la duree deja mesuree quand un nouveau depart commun reprend le morceau (KTD3)", () => {
    const room = enLecture([leo]);
    const zap = T0 + CFG.leadMs + 30_000;
    transport(room, "next", zap);
    transport(room, "previous", zap + 1_000);

    depart(room, [leo], zap + 1_000);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(30_000);
  });

  it("complete le nom de chaine arrive apres le depart commun (R2, U4)", () => {
    const room = enLecture([leo]);
    expect(ligneDe("kJQP7kiw5Fk")?.channelTitle).toBeNull();
    // La reponse oEmbed arrive apres coup: la file la connait, la ligne non.
    room.setInfo("q1", {
      title: null,
      channelTitle: "LuisFonsiVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    });

    transport(room, "next", T0 + CFG.leadMs + 10_000);

    expect(ligneDe("kJQP7kiw5Fk")).toMatchObject({
      channelTitle: "LuisFonsiVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
      listenedMs: 10_000,
    });
  });

  /*
   * L accumulation met a jour, elle ne cree jamais: un morceau que YouTube refuse de
   * decrire n a pas de ligne au depart commun (R14), et sa duree ne doit pas lui en
   * fabriquer une.
   */
  it("ne cree aucune ligne pour un morceau refuse par YouTube (AE11, R14)", () => {
    const room = enLecture([leo]);
    room.markRefused("q1");
    // La ligne de q1 existe deja, ecrite avant le refus: c est q2 qui n en aura pas.
    const zap = T0 + CFG.leadMs + 10_000;
    transport(room, "next", zap);
    room.markRefused("q2");
    depart(room, [leo], zap);

    transport(room, "next", zap + CFG.leadMs + 5_000);

    expect(db.listHistory(leo.id, 10).map((e) => e.videoId)).toEqual(["kJQP7kiw5Fk"]);
  });

  it("n ecrase pas un titre deja ecrit par une valeur vide arrivee plus tard", () => {
    recordCommonStart({ db, instanceId: "i1", snapshot: snapshot(), users: [leo], nowMs: T0 });

    recordPlayedSegment({
      db,
      instanceId: "i1",
      played: { item: item({ title: null }), listenedMs: 5_000 },
      nowMs: T0 + CFG.leadMs + 5_000,
    });

    expect(db.listHistory(leo.id, 10)[0]).toMatchObject({
      title: "Despacito", listenedMs: 5_000,
    });
  });

  /*
   * Revue du 11/09/2026, #7. Le protocole accepte une position de stagnation sans
   * plafond, la room reancre la timeline dessus, et la fin de morceau ecrit la duree
   * sur la ligne de chaque compte present: un participant pouvait ainsi inscrire une
   * duree arbitraire et definitive dans l historique de l autre. L ecriture la ramene
   * au temps ecoule depuis le premier depart commun de la ligne.
   */
  it("ramene au temps ecoule une position de stagnation hostile, sur les deux comptes (revue du 11/09/2026, #7)", () => {
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0);
    const room = enLecture([leo, ami]);
    room.join("pote", T0);
    const stagnation = T0 + CFG.leadMs + 10_000;
    room.stall("pote", 1e12, stagnation);
    const zap = stagnation + 1_000;

    transport(room, "next", zap);

    // Les deux lignes sont nees au depart commun de T0: rien n a pu s entendre avant.
    const ecoule = zap - T0;
    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(ecoule);
    expect(db.listHistory(ami.id, 10)[0]?.listenedMs).toBe(ecoule);
  });

  /*
   * Le chemin legitime de la stagnation, celui qu emprunte l attaque: une vraie pub
   * fige la lecture a sa position reelle, puis la barriere se leve. Le temps ecoule
   * compte la pub, la position non: le plafond reste loin et la duree est exacte.
   */
  it("ecrit la duree exacte d un changement de morceau apres une vraie pub (revue du 11/09/2026, #7)", () => {
    const room = enLecture([leo]);
    const pub = T0 + CFG.leadMs + 10_000;
    const attente = room.stall("leo", 10_000, pub);
    if (attente.kind === "ignored") return expect.unreachable("la stagnation aurait du ouvrir une barriere");
    const finPub = pub + 30_000;
    const levee = room.ready("leo", attente.barrierId, finPub);
    if (levee.kind !== "start") return expect.unreachable("la barriere aurait du se lever");
    recordCommonStart({ db, instanceId: "i1", snapshot: room.state(), users: [leo], nowMs: finPub });

    transport(room, "next", levee.startAtServerMs + 5_000);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(15_000);
  });

  /*
   * Le cas legitime le plus proche du plafond: le premier morceau relance par
   * « precedent » garde sa cle et son premier horodatage, et ses deux passages
   * s additionnent a une seconde du temps ecoule, les deux delais de depart.
   */
  it("additionne les deux passages d un morceau relance quand ils tiennent sous le plafond (revue du 11/09/2026, #7)", () => {
    const room = enLecture([leo]);
    const relance = T0 + CFG.leadMs + 30_000;
    transport(room, "previous", relance);
    depart(room, [leo], relance);

    transport(room, "next", relance + CFG.leadMs + 20_000);

    // 50 000 ms joues pour 51 000 ms ecoules depuis T0.
    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(50_000);
  });
});

/*
 * Une soiree abandonnee en pleine lecture (U5, R5, AE5). Le morceau reste courant, plus
 * personne n est la, et la room finit balayee: sa duree se rattrape a ce moment-la.
 */
describe("duree du dernier morceau a la destruction de la room (U5, R5)", () => {
  /** Le balayage des rooms vides tourne toutes les dix secondes (server/index.ts:36). */
  const BALAYAGE_MS = 10_000;

  let db: Db;
  let leo: User;

  beforeEach(() => {
    db = openDatabase(":memory:");
    leo = db.upsertUser({ googleSub: "sub-leo", name: "Leo", email: null }, T0);
  });

  afterEach(() => db.close());

  /*
   * Le raccordement du balayage (server/index.ts, intervalle SWEEP_MS): la room sortie
   * du registre rend son dernier segment, l appelant l ecrit. Aucune session, aucun
   * compte ne passe par la — a cet instant il n en existe plus aucun pour cette room.
   */
  function balayer(reg: ReturnType<typeof createRegistry>, nowMs: number): void {
    for (const destroyed of reg.sweep(nowMs)) {
      const played = destroyed.room.finalSegment();
      if (played) recordPlayedSegment({ db, instanceId: destroyed.instanceId, played, nowMs });
    }
  }

  /** Deux participants, deux morceaux, depart commun a la position zero emis a T0. */
  function enLecture(reg: ReturnType<typeof createRegistry>, users: Array<User | null>) {
    const { code, room } = reg.create(T0);
    const instanceId = reg.instanceOf(code) ?? "";
    room.join("leo", T0);
    room.join("pote", T0);
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.queueAdd("leo", "dQw4w9WgXcQ", T0);
    room.control("play", T0);
    const attente = room.resumeAt(0, T0);
    room.ready("leo", attente.barrierId, T0);
    room.ready("pote", attente.barrierId, T0);
    recordCommonStart({ db, instanceId, snapshot: room.state(), users, nowMs: T0 });
    return { code, room, instanceId };
  }

  const ligneDe = (videoId: string) =>
    db.listHistory(leo.id, 10).find((e) => e.videoId === videoId);

  /*
   * Le coeur de l unite (AE5, KTD2). L ecart est mesure: les deux se deconnectent quand
   * la position vaut 20 000 ms, et le balayage ne passe que 40 000 ms plus tard, delai
   * de grace puis balayage suivant. Lire la position a cet instant enregistrerait
   * 60 000 ms, dont 40 000 de silence.
   */
  it("ecrit la position au depart des deux participants, pas celle du balayage (AE5, R5)", () => {
    const reg = createRegistry(CFG);
    const { room } = enLecture(reg, [leo]);
    const depart = T0 + CFG.leadMs + 20_000;
    room.disconnect("leo", depart);
    room.disconnect("pote", depart);
    const balayage = depart + CFG.graceMs + BALAYAGE_MS;
    // La contre-mesure: c est bien 60 000 ms que rendrait l implementation naive.
    expect(room.positionNow(balayage)).toBe(60_000);

    balayer(reg, balayage);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(20_000);
  });

  /*
   * Le depart volontaire libere la place tout de suite, sans delai de grace: la room
   * est balayable des le balayage suivant, et ne laisse aucune marque de presence a
   * relire (KTD2).
   */
  it("ecrit aussi la duree quand les deux sont partis volontairement", () => {
    const reg = createRegistry(CFG);
    const { room } = enLecture(reg, [leo]);
    const depart = T0 + CFG.leadMs + 20_000;
    room.leave("leo", depart);
    room.leave("pote", depart);

    balayer(reg, depart + BALAYAGE_MS);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(20_000);
  });

  /*
   * Cas mixte. Une ancre derivee des marques de presence prendrait celle de « leo »,
   * seule survivante, et enregistrerait 20 000 ms au lieu de 70 000.
   */
  it("mesure au second depart quand l un perd sa socket et l autre part ensuite", () => {
    const reg = createRegistry(CFG);
    const { room } = enLecture(reg, [leo]);
    room.disconnect("leo", T0 + CFG.leadMs + 20_000);
    const second = T0 + CFG.leadMs + 70_000;
    room.leave("pote", second);

    balayer(reg, second + BALAYAGE_MS);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(70_000);
  });

  it("n ecrit rien quand aucun morceau n etait courant", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    room.join("leo", T0);
    room.queueAdd("leo", "kJQP7kiw5Fk", T0); // ajoute, jamais lance
    const depart = T0 + 20_000;
    room.leave("leo", depart);

    balayer(reg, depart + BALAYAGE_MS);

    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
    expect(reg.get(code)).toBeUndefined();
  });

  /*
   * La duree s ajoute, elle ne remplace pas (KTD3): le morceau avait deja ete ecoute
   * une premiere fois dans la meme seance, avant d etre rappele par « precedent ».
   */
  it("ajoute le dernier segment a la duree deja accumulee, sans la remplacer (KTD3)", () => {
    const reg = createRegistry(CFG);
    const { room, instanceId } = enLecture(reg, [leo]);
    const zap = T0 + CFG.leadMs + 30_000;
    const premier = room.control("next", zap);
    if (premier) recordPlayedSegment({ db, instanceId, played: premier, nowMs: zap });
    const suite = room.resumeAt(0, zap);
    room.ready("leo", suite.barrierId, zap);
    room.ready("pote", suite.barrierId, zap);
    recordCommonStart({ db, instanceId, snapshot: room.state(), users: [leo], nowMs: zap });
    const retour = zap + CFG.leadMs + 5_000;
    const second = room.control("previous", retour);
    if (second) recordPlayedSegment({ db, instanceId, played: second, nowMs: retour });
    const reprise = room.resumeAt(0, retour);
    room.ready("leo", reprise.barrierId, retour);
    room.ready("pote", reprise.barrierId, retour);
    const depart = retour + CFG.leadMs + 20_000;
    room.leave("leo", depart);
    room.leave("pote", depart);

    balayer(reg, depart + BALAYAGE_MS);

    expect(ligneDe("kJQP7kiw5Fk")?.listenedMs).toBe(50_000);
    expect(ligneDe("dQw4w9WgXcQ")?.listenedMs).toBe(5_000);
  });

  /*
   * Le point d accroche rend l instance parce que le registre ne la rend plus apres
   * coup: la duree doit viser la seance detruite, pas celle qui joue encore le meme
   * morceau a cote (KTD6).
   */
  it("vise la seance detruite, pas la room voisine qui joue le meme morceau", () => {
    const reg = createRegistry(CFG);
    const abandonnee = enLecture(reg, [leo]);
    const encoreLa = enLecture(reg, [leo]);
    const depart = T0 + CFG.leadMs + 20_000;
    abandonnee.room.leave("leo", depart);
    abandonnee.room.leave("pote", depart);

    balayer(reg, depart + BALAYAGE_MS);

    const lignes = db.listHistory(leo.id, 10).filter((e) => e.videoId === "kJQP7kiw5Fk");
    expect(lignes.find((e) => e.roomInstanceId === abandonnee.instanceId)?.listenedMs).toBe(20_000);
    expect(lignes.find((e) => e.roomInstanceId === encoreLa.instanceId)?.listenedMs).toBeNull();
    expect(reg.get(encoreLa.code)).toBeDefined();
  });

  /*
   * R10. La garde du compte est appliquee une fois pour toutes au depart commun: sans
   * ligne, l accumulation ne touche rien et n en fabrique aucune.
   */
  it("ne fabrique aucune ligne pour une soiree jouee entre invites", () => {
    const reg = createRegistry(CFG);
    const { room } = enLecture(reg, [null, null]);
    const depart = T0 + CFG.leadMs + 20_000;
    room.leave("leo", depart);
    room.leave("pote", depart);

    balayer(reg, depart + BALAYAGE_MS);

    expect(db.listHistory(leo.id, 10)).toHaveLength(0);
  });
});
