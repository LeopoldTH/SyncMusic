import { describe, it, expect } from "vitest";
import { createSession } from "./session";
import { createClockEstimator } from "./clock";
import { createDriftLog } from "./driftLog";
import { SYNC_THRESHOLDS } from "./thresholds";
import type { ClientMessage } from "../../shared/protocol";
import type { PlayerFault, PlayerObservation, PlayerPort } from "../player/playerPort";

function fakePlayer(observation: PlayerObservation) {
  const calls: string[] = [];
  let rateReset = false;
  let pendingFault: PlayerFault | null = null;
  let refusePlay: PlayerFault | null = null;
  const port: PlayerPort & {
    calls: string[];
    set(o: Partial<PlayerObservation>): void;
    queueRateReset(): void;
    queueFault(f: PlayerFault): void;
    refuseNextPlay(f: PlayerFault): void;
  } = {
    calls,
    set(o) { Object.assign(observation, o); },
    queueRateReset() { rateReset = true; },
    /** Le refus que le navigateur ne signale qu au tour suivant. */
    queueFault(f) { pendingFault = f; },
    /** Le refus que l adaptateur rend immediatement. */
    refuseNextPlay(f) { refusePlay = f; },
    observe: () => observation,
    seekTo: (ms) => { calls.push("seek:" + Math.round(ms)); },
    setRate: (r) => { calls.push("rate:" + r); },
    play: () => {
      calls.push("play");
      const r = refusePlay;
      refusePlay = null;
      return r;
    },
    pause: () => { calls.push("pause"); },
    load: (v) => { calls.push("load:" + v); },
    takeRateReset: () => { const p = rateReset; rateReset = false; return p; },
    takeEnded: () => false,
    takeFault: () => { const f = pendingFault; pendingFault = null; return f; },
  };
  return port;
}

/** Une session deja synchronisee, horloge convergee, depart commun recu. */
function syncedSession(observation: PlayerObservation) {
  const player = fakePlayer(observation);
  const sent: ClientMessage[] = [];
  const clock = createClockEstimator();
  const session = createSession({
    player, clock, log: createDriftLog(), thresholds: SYNC_THRESHOLDS,
    send: (m) => sent.push(m),
  });

  session.onServerMessage({ type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: true }, 0);
  for (let i = 0; i < 6; i++) {
    session.onServerMessage({ type: "clock_probe_reply", clientSentAt: i * 10, serverReceivedAt: i * 10 + 20, serverSentAt: i * 10 + 21 }, i * 10 + 40);
  }
  session.onServerMessage({ type: "common_start", barrierId: 1, positionMs: 0, startAtServerMs: 20 }, 0);
  player.calls.length = 0;
  sent.length = 0;
  return { session, player, sent };
}

describe("correction en cours", () => {
  it("laisse une correction aller a son terme sans en redecider une autre", () => {
    // Ecart de 2 s: le correcteur demande 1,20x pendant 10 s.
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);

    session.tick(60_000);
    const rateCalls = player.calls.filter((c) => c.startsWith("rate:"));
    expect(rateCalls).toEqual(["rate:1.2"]);
    expect(session.correcting()).toBe(true);

    // Neuf tours plus tard, toujours la meme correction: aucune nouvelle decision.
    for (let t = 61_000; t < 70_000; t += 1_000) session.tick(t);
    expect(player.calls.filter((c) => c.startsWith("rate:"))).toEqual(["rate:1.2"]);
    expect(session.correcting()).toBe(true);
  });

  it("remet la vitesse a 1 au terme de la correction", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    session.tick(60_000);
    session.tick(71_000);
    expect(player.calls.filter((c) => c.startsWith("rate:"))).toEqual(["rate:1.2", "rate:1"]);
    expect(session.correcting()).toBe(false);
  });

  it("annule la correction quand un changement de morceau remet la vitesse a 1", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    const rates = () => player.calls.filter((c) => c.startsWith("rate:"));

    session.tick(60_000);
    expect(rates()).toHaveLength(1);

    // Sans remise a zero, le tour suivant ne redecide rien: la correction court encore.
    obs.positionMs += 1_000;
    session.tick(61_000);
    expect(rates()).toHaveLength(1);

    // Le changement de morceau a annule la vitesse cote lecteur: la session doit en
    // reemettre une, au lieu de croire l ancienne toujours en cours.
    obs.positionMs += 1_000;
    player.queueRateReset();
    session.tick(62_000);
    expect(rates()).toHaveLength(2);
  });
});

describe("observation non fraiche et stagnation", () => {
  it("ne decide rien sur une position gelee", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: false, playing: true };
    const { session, player } = syncedSession(obs);
    session.tick(60_000);
    expect(player.calls.filter((c) => c.startsWith("rate:") || c.startsWith("seek:"))).toHaveLength(0);
  });

  it("n annonce rien sur un seul relevé sans progression", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: false, playing: true };
    const { session, sent } = syncedSession(obs);
    session.tick(60_000);
    expect(sent.some((m) => m.type === "stall")).toBe(false);
  });

  it("annonce une stagnation au deuxieme relevé consecutif", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: false, playing: true };
    const { session, sent } = syncedSession(obs);
    session.tick(60_000);
    session.tick(61_000);
    session.tick(62_000);
    expect(sent.some((m) => m.type === "stall")).toBe(true);
  });

  it("ne repete pas l annonce a chaque tour", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: false, playing: true };
    const { session, sent } = syncedSession(obs);
    for (let t = 60_000; t <= 65_000; t += 1_000) session.tick(t);
    expect(sent.filter((m) => m.type === "stall")).toHaveLength(1);
  });
});

describe("pause partagee", () => {
  it("met le lecteur en pause quand l etat partage passe a l arret", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    session.onServerMessage(
      { type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: false },
      60_000
    );
    expect(player.calls).toContain("pause");
  });

  it("cesse de corriger apres une pause: il n y a plus de timeline a suivre", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    session.onServerMessage(
      { type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: false },
      60_000
    );
    player.calls.length = 0;
    session.tick(61_000);
    expect(player.calls.filter((c) => c.startsWith("rate:") || c.startsWith("seek:"))).toHaveLength(0);
  });

  it("ne met pas en pause quand l etat partage annonce la lecture", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    session.onServerMessage(
      { type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: true },
      60_000
    );
    expect(player.calls).not.toContain("pause");
  });
});

describe("mise en attente", () => {
  it("se place a la position annoncee et se met en pause", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: true };
    const { session, player } = syncedSession(obs);
    session.onServerMessage({ type: "waiting", barrierId: 2, positionMs: 90_000, waitingFor: ["pote"], sinceServerMs: 0 }, 60_000);
    expect(player.calls).toContain("pause");
    expect(player.calls).toContain("seek:90000");
  });

  it("ne se declare pret qu une fois l horloge convergee", () => {
    const player = fakePlayer({ positionMs: 90_000, fresh: true, playing: false });
    const sent: ClientMessage[] = [];
    const session = createSession({
      player, clock: createClockEstimator(), log: createDriftLog(),
      thresholds: SYNC_THRESHOLDS, send: (m) => sent.push(m),
    });
    session.onServerMessage({ type: "waiting", barrierId: 2, positionMs: 90_000, waitingFor: ["leo"], sinceServerMs: 0 }, 0);
    session.tick(1_000);
    // Aucune sonde n a encore ete acceptee: l estimation n est pas convergee.
    expect(sent.some((m) => m.type === "ready")).toBe(false);
  });

  it("se declare pret une fois l horloge convergee", () => {
    const obs: PlayerObservation = { positionMs: 90_000, fresh: true, playing: false };
    const { session, sent } = syncedSession(obs);
    session.onServerMessage({ type: "waiting", barrierId: 2, positionMs: 90_000, waitingFor: ["leo"], sinceServerMs: 0 }, 60_000);
    session.tick(61_000);
    expect(sent.some((m) => m.type === "ready" && m.barrierId === 2)).toBe(true);
  });
});

describe("rapport de position", () => {
  it("rapporte sa position a chaque tour, fraicheur comprise", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: false, playing: true };
    const { session, sent } = syncedSession(obs);
    session.tick(60_000);
    const report = sent.find((m) => m.type === "position_report");
    expect(report).toBeDefined();
    if (report?.type === "position_report") expect(report.fresh).toBe(false);
  });
});

describe("ecart par paire", () => {
  function withPeers(mine: { positionMs: number; fresh: boolean; ageMs: number },
                     other: { positionMs: number; fresh: boolean; ageMs: number }) {
    const obs: PlayerObservation = { positionMs: 30_000, fresh: true, playing: true };
    const { session } = syncedSession(obs);
    session.onServerMessage({
      type: "peer_positions",
      atServerMs: 1_000,
      positions: [
        { participantId: "leo", ...mine },
        { participantId: "pote", ...other },
      ],
    }, 1_000);
    return session;
  }

  it("calcule l ecart quand les deux positions sont exploitables", () => {
    const s = withPeers({ positionMs: 30_400, fresh: true, ageMs: 120 },
                        { positionMs: 30_000, fresh: true, ageMs: 90 });
    expect(s.pairGapMs()).toBe(400);
  });

  it("refuse de chiffrer quand une position est figee", () => {
    const s = withPeers({ positionMs: 30_400, fresh: true, ageMs: 120 },
                        { positionMs: 30_000, fresh: false, ageMs: 90 });
    expect(s.pairGapMs()).toBe(null);
  });

  it("refuse de chiffrer sur un rapport trop vieux", () => {
    // Mieux vaut afficher "inconnu" qu un nombre que personne ne peut interpreter.
    const s = withPeers({ positionMs: 30_400, fresh: true, ageMs: 5_000 },
                        { positionMs: 30_000, fresh: true, ageMs: 90 });
    expect(s.pairGapMs()).toBe(null);
  });
});

describe("reponse de sonde incoherente", () => {
  it("ignore une reponse dont la reemission precede la reception", () => {
    const player = fakePlayer({ positionMs: 0, fresh: true, playing: false });
    const clock = createClockEstimator();
    const session = createSession({
      player, clock, log: createDriftLog(), thresholds: SYNC_THRESHOLDS, send: () => {},
    });
    for (let i = 0; i < 6; i++) {
      session.onServerMessage(
        { type: "clock_probe_reply", clientSentAt: i * 10, serverReceivedAt: i * 10 + 40, serverSentAt: i * 10 + 20 },
        i * 10 + 60
      );
    }
    // Aucune sonde acceptee: l estimation ne peut pas avoir converge.
    expect(clock.estimate().samples).toBe(0);
  });
});

/*
 * Sur iPhone, un geste sur la page ne vaut pas geste dans le cadre YouTube: la
 * lecture pilotee est refusee en silence. Le lecteur le detectait deja, personne
 * n allait chercher le resultat, et l utilisateur restait devant un bouton sans effet.
 */
describe("lecture refusee par le navigateur", () => {
  it("ne signale rien tant que tout va bien", () => {
    const obs: PlayerObservation = { positionMs: 60_000, fresh: true, playing: true };
    const { session } = syncedSession(obs);
    session.tick(60_000);
    expect(session.playbackBlockedBy()).toBeNull();
  });

  it("retient le refus que le lecteur signale au tour suivant", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);

    player.queueFault({ kind: "playback_refused" });
    session.tick(1_000);
    expect(session.playbackBlockedBy()).toBe("playback_refused");
  });

  it("retient le refus rendu immediatement par le depart commun", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);

    player.refuseNextPlay({ kind: "not_visible" });
    session.onServerMessage({ type: "common_start", barrierId: 2, positionMs: 0, startAtServerMs: 0 }, 1_000);
    expect(session.playbackBlockedBy()).toBe("not_visible");
  });

  /*
   * Le point de la consigne: elle doit s effacer quand l utilisateur a touche le
   * lecteur, sans que personne ait a penser a l effacer.
   */
  it("retombe d elle-meme des que la lecture demarre", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);

    player.queueFault({ kind: "playback_refused" });
    session.tick(1_000);
    expect(session.playbackBlockedBy()).toBe("playback_refused");

    player.set({ playing: true, positionMs: 500 });
    session.tick(2_000);
    expect(session.playbackBlockedBy()).toBeNull();
  });

  it("reste levee tant que la lecture ne part pas, sans nouveau signal", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);

    player.queueFault({ kind: "playback_refused" });
    session.tick(1_000);
    for (let i = 2; i < 8; i++) session.tick(i * 1_000);
    expect(session.playbackBlockedBy()).toBe("playback_refused");
  });
});
