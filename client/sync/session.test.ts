import { describe, it, expect } from "vitest";
import { createSession } from "./session";
import { createClockEstimator } from "./clock";
import { createDriftLog } from "./driftLog";
import { SYNC_THRESHOLDS } from "./thresholds";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { PlayerObservation, PlayerPort } from "../player/playerPort";

function fakePlayer(observation: PlayerObservation) {
  const calls: string[] = [];
  let rateReset = false;
  const port: PlayerPort & { calls: string[]; set(o: Partial<PlayerObservation>): void; queueRateReset(): void } = {
    calls,
    set(o) { Object.assign(observation, o); },
    queueRateReset() { rateReset = true; },
    observe: () => observation,
    seekTo: (ms) => { calls.push("seek:" + Math.round(ms)); },
    setRate: (r) => { calls.push("rate:" + r); },
    play: () => { calls.push("play"); },
    pause: () => { calls.push("pause"); },
    load: (v) => { calls.push("load:" + v); },
    takeRateReset: () => { const p = rateReset; rateReset = false; return p; },
    takeEnded: () => false,
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

/*
 * Defaut remonte le 28/08/2026: lecteur en pause, mais la position saute en avant
 * d une douzaine de secondes, toutes les douze secondes environ.
 *
 * Une pause prise sur les controles de l iframe ne passe pas par l etat partage: la
 * session se croit toujours en lecture. La cible avancait donc pendant que la position
 * restait figee, le correcteur consommait sa fenetre de dix secondes en vitesse sur un
 * lecteur immobile, puis l ecart accumule depassait le plafond et declenchait un saut.
 */
describe("lecteur arrete a l insu de l application", () => {
  it("ne corrige pas un lecteur qui ne joue pas", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);

    // Trente secondes: deux fois et demie la periode du saut observe.
    for (let t = 60_000; t <= 90_000; t += 1_000) session.tick(t);

    expect(player.calls.filter((c) => c.startsWith("seek:"))).toEqual([]);
    expect(player.calls.filter((c) => c.startsWith("rate:"))).toEqual([]);
  });

  it("rattrape en un seul saut des que le lecteur rejoue", () => {
    const obs: PlayerObservation = { positionMs: 58_000, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);
    for (let t = 60_000; t <= 90_000; t += 1_000) session.tick(t);

    player.set({ playing: true });
    session.tick(91_000);

    expect(player.calls.filter((c) => c.startsWith("seek:"))).toHaveLength(1);
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

/*
 * Defaut remonte le 30/08/2026, sur telephone: « le lecteur se recharge a zero en
 * boucle, puis ecran noir ».
 *
 * Le serveur reannonce l attente a chaque disponibilite recue tant que le quorum n est
 * pas atteint. Le client qui etait pret la renvoyait a chaque tour, donc chaque seconde
 * l attente etait rediffusee, et chaque rediffusion remettait les deux lecteurs en
 * pause et a la position de la barriere. L attente s auto-entretenait, et celui qu on
 * attendait ne pouvait jamais demarrer.
 */
describe("attente qui s auto-entretient", () => {
  const attente: ServerMessage =
    { type: "waiting", barrierId: 2, positionMs: 0, waitingFor: ["pote"], sinceServerMs: 0 };

  it("ne declare sa disponibilite qu une fois par barriere", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, sent } = syncedSession(obs);
    session.onServerMessage(attente, 60_000);

    for (let t = 61_000; t <= 70_000; t += 1_000) session.tick(t);

    expect(sent.filter((m) => m.type === "ready")).toHaveLength(1);
  });

  it("ne repositionne pas le lecteur sur une attente deja connue", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player } = syncedSession(obs);
    session.onServerMessage(attente, 60_000);
    player.calls.length = 0;

    // Trois rediffusions de la meme barriere, comme le serveur en emet.
    for (let i = 0; i < 3; i++) session.onServerMessage(attente, 61_000 + i * 1_000);

    expect(player.calls).toEqual([]);
  });

  it("obeit en revanche a une barriere suivante", () => {
    const obs: PlayerObservation = { positionMs: 0, fresh: true, playing: false };
    const { session, player, sent } = syncedSession(obs);
    session.onServerMessage(attente, 60_000);
    session.tick(61_000);
    player.calls.length = 0;

    session.onServerMessage({ ...attente, barrierId: 3, positionMs: 42_000 }, 62_000);
    session.tick(63_000);

    expect(player.calls).toContain("seek:42000");
    expect(sent.filter((m) => m.type === "ready" && m.barrierId === 3)).toHaveLength(1);
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
 * Constate a deux appareils le 02/09/2026: sur telephone, le premier morceau part
 * decale et ne rattrape jamais, alors que le suivant est propre.
 *
 * Aucun navigateur mobile ne laisse une machine distante lancer du son. L utilisateur
 * appuie donc sur le bouton du lecteur YouTube lui-meme. Ce geste debloque le lecteur
 * pour la session — d ou le morceau suivant qui demarre seul — mais il part de la ou
 * le lecteur se trouvait, sans que personne n ait convenu de l instant.
 */
describe("demarrage sauvage", () => {
  /** Une session qui sait la room en lecture, mais sans depart commun a suivre. */
  function sansDepart(observation: PlayerObservation) {
    const player = fakePlayer(observation);
    const sent: ClientMessage[] = [];
    const session = createSession({
      player, clock: createClockEstimator(), log: createDriftLog(),
      thresholds: SYNC_THRESHOLDS, send: (m) => sent.push(m),
    });
    session.onServerMessage({ type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: true }, 0);
    sent.length = 0;
    player.calls.length = 0;
    return { session, player, sent };
  }

  const demandes = (sent: ClientMessage[]) =>
    sent.filter((m) => m.type === "control_transport");

  it("demande un depart commun quand le lecteur part de lui-meme", () => {
    const { session, sent } = sansDepart({ positionMs: 12_000, fresh: true, playing: true });
    session.tick(1_000);
    expect(demandes(sent)).toHaveLength(1);
  });

  it("ne le demande qu une fois tant que le serveur n a pas repondu", () => {
    const { session, sent } = sansDepart({ positionMs: 12_000, fresh: true, playing: true });
    for (let t = 1_000; t <= 6_000; t += 1_000) session.tick(t);
    expect(demandes(sent)).toHaveLength(1);
  });

  it("ne demande rien quand le lecteur ne joue pas: c est le cas avant le geste", () => {
    const { session, sent } = sansDepart({ positionMs: 0, fresh: true, playing: false });
    session.tick(1_000);
    expect(demandes(sent)).toHaveLength(0);
  });

  /* Sans cette garde, une pause partagee serait aussitot annulee par le revenant. */
  it("ne relance pas une room mise en pause", () => {
    const { session, sent } = sansDepart({ positionMs: 12_000, fresh: true, playing: true });
    session.onServerMessage({ type: "room_state", code: "ABCD", youAre: "leo", participants: [{ id: "leo", name: "Leo" }, { id: "pote", name: "Pote" }], queue: [], currentItemId: null, playing: false }, 500);
    session.tick(1_000);
    expect(demandes(sent)).toHaveLength(0);
  });

  it("ne demande rien pendant une attente en cours", () => {
    const { session, sent } = sansDepart({ positionMs: 12_000, fresh: true, playing: true });
    session.onServerMessage({ type: "waiting", barrierId: 4, positionMs: 0, waitingFor: ["pote"], sinceServerMs: 0 }, 500);
    session.tick(1_000);
    expect(demandes(sent)).toHaveLength(0);
  });

  it("redemande apres une nouvelle attente restee sans suite", () => {
    const { session, sent } = sansDepart({ positionMs: 12_000, fresh: true, playing: true });
    session.tick(1_000);
    // Le serveur repond, puis le depart commun aboutit et la lecture reprend seule.
    session.onServerMessage({ type: "waiting", barrierId: 4, positionMs: 0, waitingFor: ["pote"], sinceServerMs: 0 }, 1_500);
    session.onServerMessage({ type: "common_start", barrierId: 4, positionMs: 0, startAtServerMs: 2_000 }, 1_800);
    expect(demandes(sent)).toHaveLength(1);
  });
});
