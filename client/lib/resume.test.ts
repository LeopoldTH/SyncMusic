import { describe, it, expect } from "vitest";
import { readResume, saveResume, clearResume, type ResumeRecord } from "./resume";

/** Un sessionStorage minimal: le module n en utilise que trois methodes. */
function fakeStore(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  } as Storage;
}

const RECORD: ResumeRecord = { code: "ABCD", participantId: "pa1b2c3d4e5f6", name: "Leo" };

describe("aller-retour", () => {
  it("relit ce qui vient d etre ecrit", () => {
    const store = fakeStore();
    saveResume(store, RECORD);
    expect(readResume(store)).toEqual(RECORD);
  });

  it("ne rend plus rien apres effacement", () => {
    const store = fakeStore();
    saveResume(store, RECORD);
    clearResume(store);
    expect(readResume(store)).toBeNull();
  });

  it("ne rend rien sur un onglet qui n a jamais rien fait", () => {
    expect(readResume(fakeStore())).toBeNull();
  });
});

/*
 * Le demarrage de l application depend de cette lecture. Une trace abimee doit rendre
 * `null`, jamais lever: l utilisateur retomberait sur une page blanche.
 */
describe("traces inexploitables", () => {
  const abimees: Array<[string, string]> = [
    ["pas du JSON", "{{{"],
    ["JSON qui n est pas un objet", '"ABCD"'],
    ["objet vide", "{}"],
    ["sans identifiant de participant", '{"code":"ABCD","name":"Leo"}'],
    ["identifiant au mauvais format", '{"code":"ABCD","name":"Leo","participantId":"leo"}'],
    ["code de room mal forme", '{"code":"ab1","name":"Leo","participantId":"pa1b2c3d4e5f6"}'],
    ["pseudo vide", '{"code":"ABCD","name":"","participantId":"pa1b2c3d4e5f6"}'],
    ["champ etranger", '{"code":"ABCD","name":"Leo","participantId":"pa1b2c3d4e5f6","admin":true}'],
    ["null", "null"],
  ];

  for (const [label, raw] of abimees) {
    it(`rend null: ${label}`, () => {
      expect(readResume(fakeStore({ "syncmusic.session": raw }))).toBeNull();
    });
  }
});
