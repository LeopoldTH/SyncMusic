/*
 * Attribution des codes et cycle de vie des rooms (R1, R4).
 * Le tirage est injectable pour que la collision soit testable.
 */

import { createRoom, type RoomConfig } from "./room";

export type Room = ReturnType<typeof createRoom>;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)] ?? "A";
  }
  return out;
}

export function createRegistry(config: RoomConfig, generate: () => string = randomCode) {
  const rooms = new Map<string, Room>();

  return {
    create(nowMs: number): { code: string; room: Room } {
      // Le tirage peut repeter un code deja pris: on retire plutot que d ecraser.
      let code = generate();
      for (let attempt = 0; rooms.has(code) && attempt < 64; attempt++) code = generate();
      const room = createRoom(code, config);
      rooms.set(code, room);
      void nowMs;
      return { code, room };
    },

    get(code: string): Room | undefined {
      return rooms.get(code);
    },

    /** Detruit les rooms que plus personne ne peut rejoindre. Rend les codes liberes. */
    sweep(nowMs: number): string[] {
      const destroyed: string[] = [];
      for (const [code, room] of rooms) {
        if (room.isEmpty(nowMs)) {
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
