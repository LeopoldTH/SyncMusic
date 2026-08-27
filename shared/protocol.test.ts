import { describe, it, expect } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  probeReplyIsCoherent,
} from "./protocol";

describe("messages conformes", () => {
  it("accepte un message valide et en infere le type", () => {
    const result = parseClientMessage({ type: "ready", barrierId: 3, positionMs: 12_500 });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === "ready") {
      // Si le type n'etait pas correctement infere, cette ligne ne compilerait pas.
      expect(result.value.barrierId).toBe(3);
    } else {
      expect.unreachable("le message aurait du etre reconnu comme 'ready'");
    }
  });

  it("accepte une reponse de sonde portant les trois horodatages", () => {
    const result = parseServerMessage({
      type: "clock_probe_reply",
      clientSentAt: 1000,
      serverReceivedAt: 5040,
      serverSentAt: 5042,
    });
    expect(result.ok).toBe(true);
  });
});

describe("messages invalides", () => {
  it("rejette un champ manquant en le nommant", () => {
    const result = parseClientMessage({ type: "ready", barrierId: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("positionMs");
  });

  it("rejette un champ de mauvais type", () => {
    const result = parseClientMessage({ type: "ready", barrierId: "3", positionMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("barrierId");
  });

  it("rejette un champ inconnu en le nommant", () => {
    const result = parseClientMessage({
      type: "ready",
      barrierId: 3,
      positionMs: 0,
      positionSeconds: 12,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("positionSeconds");
  });

  it("rejette un type de message inconnu", () => {
    const result = parseClientMessage({ type: "teleporte_moi" });
    expect(result.ok).toBe(false);
  });

  it("rejette une position negative", () => {
    const result = parseClientMessage({ type: "ready", barrierId: 0, positionMs: -1 });
    expect(result.ok).toBe(false);
  });

  it("accepte un envoi de playlist et rejette un identifiant douteux", () => {
    expect(parseClientMessage({ type: "send_playlist", playlistId: 3 }).ok).toBe(true);
    expect(parseClientMessage({ type: "send_playlist", playlistId: 0 }).ok).toBe(false);
    expect(parseClientMessage({ type: "send_playlist", playlistId: "3" }).ok).toBe(false);
  });

  it("rejette un code de room mal forme", () => {
    const result = parseClientMessage({ type: "join_room", code: "ab1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("code");
  });

  it("accepte une arrivee sans identifiant de participant", () => {
    const result = parseClientMessage({ type: "join_room", code: "ABCD", name: "Leo" });
    expect(result.ok).toBe(true);
  });

  it("accepte une reprise de place avec un identifiant bien forme", () => {
    const result = parseClientMessage({
      type: "join_room", code: "ABCD", name: "Leo", participantId: "pa1b2c3d4e5f6",
    });
    expect(result.ok).toBe(true);
  });

  /* Cette valeur devient une cle de map cote serveur et circule jusqu a l autre client. */
  it("rejette un identifiant de participant qui n a pas la forme produite par le serveur", () => {
    for (const participantId of ["", "leo", "p123", "P" + "a".repeat(12), "pa1b2c3d4e5f6x"]) {
      const result = parseClientMessage({ type: "join_room", code: "ABCD", name: "Leo", participantId });
      expect(result.ok).toBe(false);
    }
  });
});

describe("coherence d'une reponse de sonde", () => {
  it("accepte une reception anterieure a la reemission", () => {
    expect(probeReplyIsCoherent({
      type: "clock_probe_reply", clientSentAt: 1000, serverReceivedAt: 5040, serverSentAt: 5042,
    })).toBe(true);
  });

  it("refuse une reemission anterieure a la reception", () => {
    expect(probeReplyIsCoherent({
      type: "clock_probe_reply", clientSentAt: 1000, serverReceivedAt: 5042, serverSentAt: 5040,
    })).toBe(false);
  });

  it("ne compare jamais l'horloge du client a celle du serveur", () => {
    // Horloges tres eloignees, reponse pourtant parfaitement valide: c'est le cas
    // nominal quand les deux machines ne sont pas a la meme heure.
    expect(probeReplyIsCoherent({
      type: "clock_probe_reply", clientSentAt: 9_000_000, serverReceivedAt: 10, serverSentAt: 12,
    })).toBe(true);
  });
});
