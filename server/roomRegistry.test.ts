import { describe, it, expect } from "vitest";
import { createRegistry } from "./roomRegistry";

const CFG = { maxParticipants: 2, maxWaitMs: 45_000, leadMs: 500, graceMs: 30_000, maxQueue: 100 };
const T0 = 1_000_000;

/*
 * Duree de vie d une room quand un client en change (defaut du 16/09/2026). Les
 * handlers d arrivee rejoignaient la nouvelle room sans quitter la precedente:
 * l entree laissee derriere restait connectee pour toujours, `expired` exigeant une
 * deconnexion, donc la room n etait jamais vide et le balayage ne la detruisait
 * jamais. Ces tests fixent la sequence que le serveur doit suivre; le cablage dans
 * `server/index.ts` lui-meme n est pas couvert, ce fichier n etant pas chargeable
 * dans un test.
 */
describe("changement de room", () => {
  it("detruit la premiere room quand son unique occupant est parti ailleurs", () => {
    const reg = createRegistry(CFG);
    const premiere = reg.create(T0);
    premiere.room.join("leo", T0);

    // Ce que fait le serveur quand un client change de room: liberer, puis rejoindre.
    premiere.room.leave("leo", T0 + 1_000);
    reg.create(T0 + 1_000).room.join("leo", T0 + 1_000);

    expect(reg.sweep(T0 + 2_000).map((d) => d.code)).toEqual([premiere.code]);
  });

  it("garde la premiere room pour toujours si la place n est pas liberee", () => {
    // Le defaut lui-meme: sans le depart, une heure ne suffit pas, ni aucune duree.
    const reg = createRegistry(CFG);
    const premiere = reg.create(T0);
    premiere.room.join("leo", T0);
    reg.create(T0 + 1_000).room.join("leo", T0 + 1_000);

    expect(reg.sweep(T0 + 3_600_000)).toEqual([]);
    expect(reg.size()).toBe(2);
  });

  it("laisse vivre la room ou quelqu un reste", () => {
    const reg = createRegistry(CFG);
    const premiere = reg.create(T0);
    premiere.room.join("leo", T0);
    premiere.room.join("pote", T0);

    premiere.room.leave("leo", T0 + 1_000);

    expect(reg.sweep(T0 + 2_000)).toEqual([]);
    expect(premiere.room.state().participants.map((p) => p.id)).toEqual(["pote"]);
  });

  it("libere la place sans attendre le delai de grace", () => {
    // Un depart vers une autre room est volontaire: la place part tout de suite,
    // sinon celui qui reste patiente l attente maximale pour quelqu un qui ne
    // reviendra pas.
    const reg = createRegistry(CFG);
    const premiere = reg.create(T0);
    premiere.room.join("leo", T0);
    premiere.room.leave("leo", T0 + 1_000);

    expect(premiere.room.reclaimable("leo", T0 + 1_000)).toBe(false);
    expect(reg.sweep(T0 + 1_000).map((d) => d.code)).toEqual([premiere.code]);
  });
});

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
    expect(destroyed.map((d) => d.code)).toContain(vide.code);
    expect(destroyed.map((d) => d.code)).not.toContain(occupee.code);
    expect(reg.get(vide.code)).toBeUndefined();
    expect(reg.get(occupee.code)).toBeDefined();
  });

  it("detruit une room dont tout le monde est parti depuis longtemps", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    room.join("leo", T0);
    room.disconnect("leo", T0);
    expect(reg.sweep(T0 + CFG.graceMs - 1).map((d) => d.code)).not.toContain(code);
    expect(reg.sweep(T0 + CFG.graceMs + 1).map((d) => d.code)).toContain(code);
  });
});

/*
 * Le point d accroche de U5. Le balayage rendait les codes seuls, et l appelant les
 * jetait; il doit maintenant rendre de quoi ecrire la duree du dernier morceau (R5).
 */
describe("point d accroche a la destruction (U5)", () => {
  it("rend la room detruite et son instance, le temps d une derniere lecture", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    const instanceId = reg.instanceOf(code);

    const [destroyed] = reg.sweep(T0 + CFG.graceMs + 1);

    expect(destroyed?.code).toBe(code);
    expect(destroyed?.room).toBe(room);
    expect(destroyed?.instanceId).toBe(instanceId);
  });

  /*
   * La raison d etre du point d accroche: apres le balayage l entree du registre
   * n existe plus, donc l instance ne se retrouve plus par le code. Sans elle, la
   * duree n aurait aucune cle ou aller (KTD6).
   */
  it("est le seul moyen d avoir l instance: le registre ne la rend plus apres coup", () => {
    const reg = createRegistry(CFG);
    const { code } = reg.create(T0);

    reg.sweep(T0 + CFG.graceMs + 1);

    expect(reg.instanceOf(code)).toBeUndefined();
  });

  it("ne rend rien pour une room encore occupee", () => {
    const reg = createRegistry(CFG);
    const { code, room } = reg.create(T0);
    room.join("leo", T0);

    expect(reg.sweep(T0 + CFG.graceMs + 1)).toEqual([]);
    expect(reg.get(code)).toBeDefined();
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
