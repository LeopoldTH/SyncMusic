import { describe, it, expect } from "vitest";
import { aRejouer, type Recu } from "./replay";
import type { ServerMessage } from "../../shared/protocol";

const etat: ServerMessage = {
  type: "room_state", code: "ABCD", youAre: "leo",
  participants: [{ id: "leo", name: "Leo" }], queue: [], currentItemId: null, playing: true,
};
const attente: ServerMessage =
  { type: "waiting", barrierId: 7, positionMs: 0, waitingFor: ["leo"], sinceServerMs: 0 };
const depart: ServerMessage =
  { type: "common_start", barrierId: 7, positionMs: 0, startAtServerMs: 500 };
const sonde: ServerMessage =
  { type: "clock_probe_reply", clientSentAt: 10, serverReceivedAt: 30, serverSentAt: 31 };

const MAINTENANT = 100_000;

describe("rejeu vers une session neuve", () => {
  /*
   * Le defaut du 04/09/2026: le meme depart commun etait applique deux fois, la
   * seconde avec son horodatage d origine, ce qui faisait reculer le lecteur.
   */
  it("n applique un genre memorise qu une fois, meme s il est aussi en file", () => {
    const file: Recu[] = [{ message: depart, atMs: 30_000 }];
    const sortie = aRejouer([etat, null, depart], file, MAINTENANT);

    const departs = sortie.filter((r) => r.message.type === "common_start");
    expect(departs).toHaveLength(1);
    expect(departs[0]?.atMs).toBe(MAINTENANT);
  });

  /* L attente doit voyager, sinon la session neuve ne se declare jamais prete. */
  it("rejoue l attente en cours, apres l etat et avant le depart", () => {
    const sortie = aRejouer([etat, attente, null], [], MAINTENANT);
    expect(sortie.map((r) => r.message.type)).toEqual(["room_state", "waiting"]);
  });

  it("garde l ordre etat, attente, depart", () => {
    const sortie = aRejouer([etat, attente, depart], [], MAINTENANT);
    expect(sortie.map((r) => r.message.type)).toEqual(["room_state", "waiting", "common_start"]);
  });

  /*
   * La sonde d horloge mesure un aller-retour: son instant de reception est la mesure
   * elle-meme. La rejouer a l heure courante gonflerait l aller-retour de tout le
   * temps de chargement du lecteur.
   */
  it("laisse a la sonde d horloge son horodatage d origine", () => {
    const file: Recu[] = [{ message: sonde, atMs: 42 }];
    const sortie = aRejouer([etat, null, null], file, MAINTENANT);

    const sondes = sortie.filter((r) => r.message.type === "clock_probe_reply");
    expect(sondes).toHaveLength(1);
    expect(sondes[0]?.atMs).toBe(42);
  });

  it("ne rejoue rien quand il n y a rien a dire", () => {
    expect(aRejouer([null, null, null], [], MAINTENANT)).toEqual([]);
  });
});
