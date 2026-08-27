import { describe, it, expect } from "vitest";
import { createRegistry } from "./roomRegistry";

const CFG = { maxParticipants: 2, maxWaitMs: 45_000, leadMs: 500, graceMs: 30_000 };
const T0 = 1_000_000;

describe("attribution des codes", () => {
  it("rend un code de quatre lettres majuscules", () => {
    const reg = createRegistry(CFG);
    expect(reg.create(T0).code).toMatch(/^[A-Z]{4}$/);
  });

  it("rend deux codes differents pour deux creations successives", () => {
    const reg = createRegistry(CFG);
    expect(reg.create(T0).code).not.toBe(reg.create(T0).code);
  });

  it("evite une collision quand le tirage repete le meme code", () => {
    // Generateur truque: deux fois le meme code, puis un autre.
    const codes = ["AAAA", "AAAA", "BBBB"];
    let i = 0;
    const reg = createRegistry(CFG, () => codes[Math.min(i++, codes.length - 1)] ?? "ZZZZ");
    expect(reg.create(T0).code).toBe("AAAA");
    expect(reg.create(T0).code).toBe("BBBB");
  });
});

describe("recherche et destruction", () => {
  it("retrouve une room par son code", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    expect(reg.get(code)).toBe(room);
  });

  it("ne trouve rien pour un code inconnu", () => {
    expect(createRegistry(CFG).get("ZZZZ")).toBeUndefined();
  });

  it("detruit une room vide et garde une room occupee", () => {
    const reg = createRegistry(CFG);
    const vide = reg.create(T0);
    const occupee = reg.create(T0);
    occupee.room.join("leo", T0);

    const destroyed = reg.sweep(T0 + CFG.graceMs + 1);
    expect(destroyed).toContain(vide.code);
    expect(reg.get(vide.code)).toBeUndefined();
    expect(reg.get(occupee.code)).toBeDefined();
  });

  it("detruit une room dont tout le monde est parti depuis longtemps", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    room.join("leo", T0);
    room.disconnect("leo", T0);
    expect(reg.sweep(T0 + CFG.graceMs - 1)).not.toContain(code);
    expect(reg.sweep(T0 + CFG.graceMs + 1)).toContain(code);
  });
});

describe("instance de room (KTD6)", () => {
  it("donne une instance a chaque room, et rien pour un code inconnu", () => {
    const reg = createRegistry(CFG);
    const { code } = reg.create(T0);
    expect(reg.instanceOf(code)).toBeDefined();
    expect(reg.instanceOf("ZZZZ")).toBeUndefined();
  });

  it("un code recycle porte une nouvelle instance: les cles d historique ne se croisent jamais", () => {
    // Meme code a chaque tirage: la seconde room reprend le code de la premiere.
    const reg = createRegistry(CFG, () => "AAAA");
    const first = reg.instanceOf(reg.create(T0).code);
    reg.sweep(T0 + CFG.graceMs + 1);
    const second = reg.instanceOf(reg.create(T0).code);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});
