import { describe, it, expect } from "vitest";
import { createBarrier } from "./barrier";

const CFG = { participants: ["a", "b"], maxWaitMs: 45_000, leadMs: 500 };

describe("cycle nominal", () => {
  it("emet un depart commun quand tous les participants sont prets", () => {
    const b = createBarrier(CFG);
    const opened = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    expect(opened.kind).toBe("waiting");

    b.ready({ barrierId: opened.barrierId, participantId: "a" }, 1_100);
    const out = b.ready({ barrierId: opened.barrierId, participantId: "b" }, 1_200);
    expect(out.kind).toBe("start");
    if (out.kind === "start") {
      expect(out.positionMs).toBe(30_000);
      expect(out.startAtServerMs).toBeGreaterThan(1_200);
    }
  });

  it("repart a l'expiration du delai si au moins un participant est pret", () => {
    const b = createBarrier(CFG);
    const opened = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.ready({ barrierId: opened.barrierId, participantId: "a" }, 1_100);
    const out = b.tick(1_000 + CFG.maxWaitMs + 1);
    expect(out.kind).toBe("start");
  });

  it("prolonge l'attente a l'expiration si personne n'est pret", () => {
    const b = createBarrier(CFG);
    b.open({ positionMs: 30_000, atServerMs: 1_000 });
    const out = b.tick(1_000 + CFG.maxWaitMs + 1);
    expect(out.kind).toBe("waiting");
  });
});

describe("identifiant de barriere", () => {
  it("ignore une disponibilite portant un identifiant perime", () => {
    const b = createBarrier(CFG);
    const first = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.ready({ barrierId: first.barrierId, participantId: "a" }, 1_100);
    const second = b.open({ positionMs: 90_000, atServerMs: 2_000 });
    expect(second.barrierId).not.toBe(first.barrierId);

    // Le "pret" de l'ancienne barriere ne doit pas completer le quorum de la nouvelle.
    const stale = b.ready({ barrierId: first.barrierId, participantId: "a" }, 2_100);
    expect(stale.kind).toBe("ignored");
    const out = b.ready({ barrierId: second.barrierId, participantId: "b" }, 2_200);
    expect(out.kind).toBe("waiting");
  });

});

describe("cas limites", () => {
  it("un arrivant en cours d'attente ne relance pas prematurement", () => {
    const b = createBarrier({ ...CFG, participants: ["a", "b"] });
    const opened = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.ready({ barrierId: opened.barrierId, participantId: "a" }, 1_100);
    b.addParticipant("c", 1_150);
    const out = b.ready({ barrierId: opened.barrierId, participantId: "b" }, 1_200);
    expect(out.kind).toBe("waiting");
  });

  /*
   * `settle` existe pour le depart volontaire: le quorum se recompte sur ceux qui
   * restent, sinon l attente court jusqu'au delai maximum pour rien.
   */
  it("part des qu'un depart laisse ceux qui restent tous prets", () => {
    const b = createBarrier(CFG);
    const opened = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.ready({ barrierId: opened.barrierId, participantId: "a" }, 1_100);
    b.removeParticipant("b");
    expect(b.settle(1_200).kind).toBe("start");
  });

  it("attend encore quand celui qui reste n'est pas pret", () => {
    const b = createBarrier(CFG);
    b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.removeParticipant("b");
    const out = b.settle(1_200);
    expect(out.kind).toBe("waiting");
    if (out.kind === "waiting") expect(out.waitingFor).toEqual(["a"]);
  });

  it("ne fait rien quand la barriere est fermee ou qu'il ne reste personne", () => {
    const closed = createBarrier(CFG);
    expect(closed.settle(1_000).kind).toBe("ignored");

    const deserted = createBarrier(CFG);
    deserted.open({ positionMs: 30_000, atServerMs: 1_000 });
    deserted.removeParticipant("a");
    deserted.removeParticipant("b");
    expect(deserted.settle(1_100).kind).toBe("ignored");
  });

  it("place l'instant de depart dans le futur, jamais dans le passe", () => {
    const b = createBarrier(CFG);
    const opened = b.open({ positionMs: 30_000, atServerMs: 1_000 });
    b.ready({ barrierId: opened.barrierId, participantId: "a" }, 1_100);
    const out = b.ready({ barrierId: opened.barrierId, participantId: "b" }, 1_200);
    if (out.kind !== "start") return expect.unreachable("un depart etait attendu");
    expect(out.startAtServerMs - 1_200).toBeGreaterThanOrEqual(CFG.leadMs);
  });
});
