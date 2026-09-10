import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db, type User } from "./db";
import { recordCommonStart } from "./history";
import { createRoom, type RoomSnapshot } from "./room";
import { fetchEachVideoInfo } from "./videoInfo";

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

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(impl: (...args: unknown[]) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

const oembed = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

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
