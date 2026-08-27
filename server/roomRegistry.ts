import { randomBytes, randomInt } from "node:crypto";
/*
 * Attribution des codes et cycle de vie des rooms (R1, R4).
 * Le tirage est injectable pour que la collision soit testable.
 */

import { createRoom, type RoomConfig } from "./room";

export type Room = ReturnType<typeof createRoom>;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/*
 * Identifiant d instance de room (KTD6), jamais recycle. Le code a quatre lettres se
 * reattribue apres sweep: deux ecoutes sans rapport porteraient la meme cle
 * d historique, et la seconde serait perdue comme faux doublon. L instance, elle,
 * est unique pour toujours.
 */
function newInstanceId(): string {
  return "i" + randomBytes(6).toString("hex");
}

/*
 * Le code de room est le seul controle d acces de l application (KD9): il n y a ni
 * compte ni mot de passe. Math.random n est pas fait pour ca — son etat interne se
 * reconstitue a partir de quelques tirages observes, ce qui permettrait de deviner
 * les codes suivants. randomInt puise dans la source cryptographique du systeme.
 */
function randomCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[randomInt(ALPHABET.length)] ?? "A";
  return out;
}

export function createRegistry(config: RoomConfig, generate: () => string = randomCode) {
  const rooms = new Map<string, { room: Room; instanceId: string }>();

  return {
    create(nowMs: number): { code: string; room: Room } {
      // Le tirage peut repeter un code deja pris: on retire plutot que d ecraser.
      let code = generate();
      for (let attempt = 0; rooms.has(code) && attempt < 64; attempt++) code = generate();
      const room = createRoom(code, config);
      rooms.set(code, { room, instanceId: newInstanceId() });
      void nowMs;
      return { code, room };
    },

    get(code: string): Room | undefined {
      return rooms.get(code)?.room;
    },

    /** L identifiant d instance, seul autorise dans une cle persistee (KTD6). */
    instanceOf(code: string): string | undefined {
      return rooms.get(code)?.instanceId;
    },

    /** Detruit les rooms que plus personne ne peut rejoindre. Rend les codes liberes. */
    sweep(nowMs: number): string[] {
      const destroyed: string[] = [];
      for (const [code, entry] of rooms) {
        if (entry.room.isEmpty(nowMs)) {
          rooms.delete(code);
          destroyed.push(code);
        }
      }
      return destroyed;
    },

    size(): number {
      return rooms.size;
    },
  };
}
