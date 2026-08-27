import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db, type User } from "./db";
import { recordCommonStart } from "./history";
import type { RoomSnapshot } from "./room";

const T0 = 1_700_000_000_000;

function snapshot(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    code: "ABCD",
    participants: [],
    queue: [{ itemId: "q1", videoId: "kJQP7kiw5Fk", addedBy: "p1", title: "Despacito" }],
    currentItemId: "q1",
    playing: true,
    ...over,
  };
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
      snapshot: snapshot({ queue: [{ itemId: "q1", videoId: "kJQP7kiw5Fk", addedBy: "p1", title: null }] }),
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
});
