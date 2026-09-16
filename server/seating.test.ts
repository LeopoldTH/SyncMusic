import { describe, it, expect } from "vitest";
import { createRegistry } from "./roomRegistry";
import { enterRoom, type Seat, type SeatingDeps } from "./seating";

const CFG = { maxParticipants: 2, maxWaitMs: 45_000, leadMs: 500, graceMs: 30_000, maxQueue: 100 };
const T0 = 1_000_000;

/*
 * Le banc porte un registre reel: c est lui qui decide si une room est detruite, et
 * c est la seule question qui compte ici. Les departs sont enregistres plutot que
 * diffuses, le transport n appartenant pas a ce module.
 */
function banc() {
  const registry = createRegistry(CFG);
  const departs: Array<{ code: string; restants: number; outcome: string }> = [];
  const deps: SeatingDeps = {
    getRoom: (code) => registry.get(code),
    onDeparture: (code, room, outcome) => { departs.push({ code, restants: room.state().participants.length, outcome: outcome.kind }); },
  };
  const entrer = (seat: Seat, cible: { code: string; room: ReturnType<typeof registry.create>["room"] }, id: string, at: number) =>
    enterRoom(seat, cible.code, cible.room, id, "Leo", at, deps);
  return { registry, departs, deps, entrer };
}

describe("arrivee dans une room", () => {
  it("libere la place precedente, ce qui rend l ancienne room destructible", () => {
    const { registry, entrer } = banc();
    const seat: Seat = { participantId: "leo", code: null };
    const premiere = registry.create(T0);
    const seconde = registry.create(T0);

    entrer(seat, premiere, "leo", T0);
    entrer(seat, seconde, "leo", T0 + 1_000);

    expect(seat.code).toBe(seconde.code);
    expect(premiere.room.state().participants).toEqual([]);
    expect(registry.sweep(T0 + 2_000).map((d) => d.code)).toEqual([premiere.code]);
  });

  it("previent la room quittee du depart, avec la place liberee", () => {
    const { registry, departs, entrer } = banc();
    const seat: Seat = { participantId: "leo", code: null };
    const premiere = registry.create(T0);
    entrer(seat, premiere, "leo", T0);

    entrer(seat, registry.create(T0), "leo", T0 + 1_000);

    // La place est bien partie: la room quittee n a plus personne a prevenir.
    expect(departs).toEqual([{ code: premiere.code, restants: 0, outcome: "ignored" }]);
  });

  it("ne libere rien quand on rejoint la place qu on occupe deja", () => {
    // Le rafraichissement. Liberer ici ferait perdre sa place au revenant.
    const { registry, departs, entrer } = banc();
    const seat: Seat = { participantId: "leo", code: null };
    const room = registry.create(T0);
    entrer(seat, room, "leo", T0);

    entrer(seat, room, "leo", T0 + 1_000);

    expect(departs).toEqual([]);
    expect(room.room.state().participants.map((p) => p.id)).toEqual(["leo"]);
    expect(registry.sweep(T0 + 2_000)).toEqual([]);
  });

  it("libere sa propre place quand on reprend une autre place de la meme room", () => {
    // Sans ca, la place qu on abandonne reste fantome dans la room ou l on est encore.
    const { registry, departs, entrer } = banc();
    const room = registry.create(T0);
    room.room.join("pote", T0);
    room.room.disconnect("pote", T0);
    const seat: Seat = { participantId: "leo", code: null };
    entrer(seat, room, "leo", T0);

    entrer(seat, room, "pote", T0 + 1_000);

    expect(departs).toEqual([{ code: room.code, restants: 1, outcome: "ignored" }]);
    expect(seat.participantId).toBe("pote");
    expect(room.room.state().participants.map((p) => p.id)).toEqual(["pote"]);
  });

  it("garde sa place quand la room visee refuse l arrivee", () => {
    // Taper le code d une room pleine ne doit pas couter la sienne: la regression du
    // 16/09/2026 rendait la place avant de savoir si la suivante etait acquise.
    const { registry, departs, entrer } = banc();
    const sienne = registry.create(T0);
    const seat: Seat = { participantId: "leo", code: null };
    entrer(seat, sienne, "leo", T0);

    const pleine = registry.create(T0);
    pleine.room.join("un", T0);
    pleine.room.join("deux", T0);

    const refus = entrer(seat, pleine, "leo", T0 + 1_000);

    expect(refus).toMatchObject({ ok: false, code: "room_full" });
    expect(seat.code).toBe(sienne.code);
    expect(departs).toEqual([]);
    expect(sienne.room.state().participants.map((p) => p.id)).toEqual(["leo"]);
  });

  it("ne cherche pas a prevenir une room deja balayee", () => {
    const { registry, departs, entrer } = banc();
    const seat: Seat = { participantId: "leo", code: null };
    const premiere = registry.create(T0);
    entrer(seat, premiere, "leo", T0);
    premiere.room.leave("leo", T0 + 1_000);
    registry.sweep(T0 + 2_000);

    expect(entrer(seat, registry.create(T0), "leo", T0 + 3_000)).toEqual({ ok: true });
    expect(departs).toEqual([]);
  });
});
