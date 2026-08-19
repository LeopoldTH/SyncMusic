import { describe, it, expect } from "vitest";
import { createRoom } from "./room";

const CFG = { maxParticipants: 2, maxWaitMs: 45_000, leadMs: 500, graceMs: 30_000 };
const T0 = 1_000_000;

function roomWithTwo() {
  const room = createRoom("ABCD", CFG);
  room.join("leo", T0);
  room.join("pote", T0 + 100);
  return room;
}

describe("arrivees et departs", () => {
  it("accepte deux participants", () => {
    const room = createRoom("ABCD", CFG);
    expect(room.join("leo", T0).ok).toBe(true);
    expect(room.join("pote", T0).ok).toBe(true);
  });

  it("refuse un troisieme participant", () => {
    const room = roomWithTwo();
    const third = room.join("tiers", T0 + 200);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("room_full");
  });

  it("marque un participant deconnecte sans le retirer tout de suite", () => {
    const room = roomWithTwo();
    room.disconnect("pote", T0 + 1_000);
    expect(room.state().participants.map((p) => p.id)).toContain("pote");
    expect(room.isEmpty(T0 + 1_000)).toBe(false);
  });

  it("retrouve la room et sa file lors d une reconnexion pendant le delai de grace", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0 + 500);
    room.disconnect("pote", T0 + 1_000);
    const back = room.join("pote", T0 + 5_000);
    expect(back.ok).toBe(true);
    expect(room.state().queue).toHaveLength(1);
  });

  it("n est vide qu une fois le delai de grace ecoule pour tout le monde", () => {
    const room = roomWithTwo();
    room.disconnect("leo", T0);
    room.disconnect("pote", T0);
    expect(room.isEmpty(T0 + CFG.graceMs - 1)).toBe(false);
    expect(room.isEmpty(T0 + CFG.graceMs + 1)).toBe(true);
  });

  it("laisse une place libre apres l expiration du delai de grace", () => {
    const room = roomWithTwo();
    room.disconnect("pote", T0);
    const third = room.join("tiers", T0 + CFG.graceMs + 1);
    expect(third.ok).toBe(true);
  });
});

describe("file de lecture", () => {
  it("ajoute en fin de file", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.queueAdd("pote", "dQw4w9WgXcQ", T0 + 10);
    expect(room.state().queue.map((i) => i.videoId)).toEqual(["kJQP7kiw5Fk", "dQw4w9WgXcQ"]);
  });

  it("retire un morceau pas encore joue", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    const second = room.queueAdd("leo", "dQw4w9WgXcQ", T0 + 10);
    if (!second.ok) return expect.unreachable("l ajout aurait du reussir");
    expect(room.queueRemove("pote", second.itemId, T0 + 20).ok).toBe(true);
    expect(room.state().queue).toHaveLength(1);
  });

  it("refuse de retirer le morceau en cours de lecture", () => {
    const room = roomWithTwo();
    const first = room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    if (!first.ok) return expect.unreachable("l ajout aurait du reussir");
    room.control("play", T0 + 10);
    const removed = room.queueRemove("leo", first.itemId, T0 + 20);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.code).toBe("cannot_remove_playing");
    expect(room.state().queue).toHaveLength(1);
  });

  it("arrete la lecture quand la file se vide", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0 + 10);
    room.control("next", T0 + 20);
    expect(room.state().playing).toBe(false);
    expect(room.state().currentItemId).toBe(null);
  });
});

describe("controle concurrent", () => {
  it("laisse l etat correspondant a la seconde action recue", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0 + 10);
    room.control("pause", T0 + 11);
    expect(room.state().playing).toBe(false);
  });
});

describe("horloge et positions", () => {
  it("repond a une sonde avec trois horodatages coherents", () => {
    const room = roomWithTwo();
    const reply = room.clockProbe(999, T0 + 40);
    expect(reply.clientSentAt).toBe(999);
    expect(reply.serverReceivedAt).toBe(T0 + 40);
    expect(reply.serverSentAt).toBeGreaterThanOrEqual(reply.serverReceivedAt);
  });

  it("rediffuse la position rapportee par chaque participant", () => {
    const room = roomWithTwo();
    room.reportPosition("leo", { positionMs: 30_000, fresh: true }, T0 + 100);
    room.reportPosition("pote", { positionMs: 30_400, fresh: true }, T0 + 120);
    const peers = room.peerPositions(T0 + 130);
    expect(peers.positions).toHaveLength(2);
    expect(peers.positions.find((p) => p.participantId === "pote")?.positionMs).toBe(30_400);
  });

  it("ouvre une barriere sur une stagnation annoncee", () => {
    const room = roomWithTwo();
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0 + 10);
    const out = room.stall("pote", 30_000, T0 + 20);
    expect(out.kind).toBe("waiting");
  });
});

describe("arrivee en cours de lecture (F1)", () => {
  function playingRoom() {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0);
    const opened = room.resumeAt(0, T0);
    room.ready("leo", opened.barrierId, T0 + 100);
    return room;
  }

  it("connait la position courante une fois le depart commun emis", () => {
    const room = playingRoom();
    // Le depart a ete place a T0 + 100 + leadMs, la lecture a donc 5 s d avance
    // 5 s plus tard, moins la marge.
    const position = room.positionNow(T0 + 100 + CFG.leadMs + 5_000);
    expect(position).toBeCloseTo(5_000, -2);
  });

  it("ouvre une barriere quand un participant arrive pendant la lecture", () => {
    const room = playingRoom();
    room.join("pote", T0 + 10_000);
    const rejoin = room.rejoinBarrier(T0 + 10_000);
    expect(rejoin).not.toBe(null);
    expect(rejoin?.waitingFor).toContain("pote");
    expect(rejoin?.positionMs).toBeGreaterThan(9_000);
  });

  it("n ouvre aucune barriere quand rien ne joue", () => {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    expect(room.rejoinBarrier(T0)).toBe(null);
  });

  it("fige la position rapportee pendant une pause", () => {
    const room = playingRoom();
    const before = room.positionNow(T0 + 10_000);
    room.control("pause", T0 + 10_000);
    expect(room.positionNow(T0 + 60_000)).toBeLessThanOrEqual(before);
  });
});

describe("reprise apres pause", () => {
  function playingAt(startMs: number) {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0);
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0);
    const opened = room.resumeAt(startMs, T0);
    room.ready("leo", opened.barrierId, T0);
    return room;
  }

  it("fige la position au moment de la pause", () => {
    const room = playingAt(0);
    const atPause = T0 + CFG.leadMs + 30_000;
    room.control("pause", atPause);
    expect(room.positionNow(atPause)).toBeCloseTo(30_000, -2);
    // Et elle ne bouge plus tant qu on ne repart pas.
    expect(room.positionNow(atPause + 120_000)).toBeCloseTo(30_000, -2);
  });

  it("reprend la ou on s etait arrete, pas au debut", () => {
    const room = playingAt(0);
    const atPause = T0 + CFG.leadMs + 45_000;
    room.control("pause", atPause);
    room.control("play", atPause + 5_000);
    expect(room.positionNow(atPause + 5_000)).toBeCloseTo(45_000, -2);
  });

  it("repart de zero au morceau suivant", () => {
    const room = playingAt(0);
    room.queueAdd("leo", "dQw4w9WgXcQ", T0);
    room.control("pause", T0 + CFG.leadMs + 45_000);
    room.control("next", T0 + CFG.leadMs + 46_000);
    expect(room.positionNow(T0 + CFG.leadMs + 46_000)).toBe(0);
  });

  it("repart de zero au morceau precedent", () => {
    const room = playingAt(0);
    room.queueAdd("leo", "dQw4w9WgXcQ", T0);
    room.control("next", T0 + 1_000);
    room.control("previous", T0 + 2_000);
    expect(room.positionNow(T0 + 2_000)).toBe(0);
  });
});

describe("pseudos", () => {
  it("retient le pseudo de chaque participant", () => {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0, "Leo");
    room.join("pote", T0, "Bibou");
    expect(room.state().participants).toEqual([
      { id: "leo", name: "Leo" },
      { id: "pote", name: "Bibou" },
    ]);
  });

  it("met le pseudo a jour a la reconnexion", () => {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0, "Leo");
    room.disconnect("leo", T0);
    room.join("leo", T0 + 1_000, "Leopold");
    expect(room.state().participants[0]?.name).toBe("Leopold");
  });
});

describe("fin de piste", () => {
  function twoTracks() {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0, "Leo");
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.queueAdd("leo", "dQw4w9WgXcQ", T0);
    room.control("play", T0);
    return room;
  }

  it("avance au morceau suivant", () => {
    const room = twoTracks();
    const first = room.state().currentItemId;
    const outcome = room.trackEnded(first ?? "", T0 + 1_000);
    expect(outcome).toEqual({ advanced: true, hasNext: true });
    expect(room.state().currentItemId).not.toBe(first);
  });

  it("ignore un second rapport pour le meme morceau", () => {
    // Les deux clients annoncent la fin: le serveur ne doit avancer qu une fois.
    const room = twoTracks();
    const first = room.state().currentItemId ?? "";
    room.trackEnded(first, T0 + 1_000);
    const second = room.trackEnded(first, T0 + 1_100);
    expect(second.advanced).toBe(false);
    expect(room.state().currentItemId).toBe("q2");
  });

  it("arrete la lecture a la fin de la file", () => {
    const room = twoTracks();
    room.trackEnded(room.state().currentItemId ?? "", T0 + 1_000);
    const last = room.trackEnded(room.state().currentItemId ?? "", T0 + 2_000);
    expect(last).toEqual({ advanced: true, hasNext: false });
    expect(room.state().playing).toBe(false);
    expect(room.state().currentItemId).toBe(null);
  });
});

describe("recalage des positions rapportees", () => {
  function playingRoomWithReports() {
    const room = createRoom("ABCD", CFG);
    room.join("leo", T0, "Leo");
    room.join("pote", T0, "Pote");
    room.queueAdd("leo", "kJQP7kiw5Fk", T0);
    room.control("play", T0);
    const opened = room.resumeAt(0, T0);
    room.ready("leo", opened.barrierId, T0);
    room.ready("pote", opened.barrierId, T0);
    return room;
  }

  it("ramene deux rapports decales au meme instant", () => {
    const room = playingRoomWithReports();
    // Les deux lecteurs sont parfaitement en phase, mais rapportent a 800 ms d ecart.
    room.reportPosition("leo", { positionMs: 30_000, fresh: true }, T0 + 10_000);
    room.reportPosition("pote", { positionMs: 30_800, fresh: true }, T0 + 10_800);

    const peers = room.peerPositions(T0 + 10_800);
    const leo = peers.positions.find((p) => p.participantId === "leo");
    const pote = peers.positions.find((p) => p.participantId === "pote");
    // Sans recalage on lirait 800 ms d ecart alors qu il n y en a aucun.
    expect((leo?.positionMs ?? 0) - (pote?.positionMs ?? 0)).toBe(0);
  });

  it("annonce l age de chaque rapport", () => {
    const room = playingRoomWithReports();
    room.reportPosition("leo", { positionMs: 30_000, fresh: true }, T0 + 10_000);
    const peers = room.peerPositions(T0 + 10_600);
    expect(peers.positions.find((p) => p.participantId === "leo")?.ageMs).toBe(600);
  });

  it("n extrapole pas une position figee", () => {
    const room = playingRoomWithReports();
    room.reportPosition("leo", { positionMs: 30_000, fresh: false }, T0 + 10_000);
    const peers = room.peerPositions(T0 + 12_000);
    expect(peers.positions.find((p) => p.participantId === "leo")?.positionMs).toBe(30_000);
  });

  it("n extrapole pas pendant une pause", () => {
    const room = playingRoomWithReports();
    room.reportPosition("leo", { positionMs: 30_000, fresh: true }, T0 + 10_000);
    room.control("pause", T0 + 10_100);
    const peers = room.peerPositions(T0 + 20_000);
    expect(peers.positions.find((p) => p.participantId === "leo")?.positionMs).toBe(30_000);
  });
});
