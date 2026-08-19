import { describe, it, expect } from "vitest";
import { parseVideoId } from "./videoId";

describe("identifiants acceptes", () => {
  const cases: Array<[string, string]> = [
    ["kJQP7kiw5Fk", "identifiant seul"],
    ["https://www.youtube.com/watch?v=kJQP7kiw5Fk", "lien complet"],
    ["https://www.youtube.com/watch?v=kJQP7kiw5Fk&t=42s", "lien avec horodatage"],
    ["https://youtu.be/kJQP7kiw5Fk", "lien court"],
    ["https://www.youtube.com/embed/kJQP7kiw5Fk", "lecteur embarque"],
    ["https://www.youtube.com/shorts/kJQP7kiw5Fk", "format court"],
    ["  kJQP7kiw5Fk  ", "espaces autour"],
  ];

  for (const [input, label] of cases) {
    it(`accepte: ${label}`, () => {
      const result = parseVideoId(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.videoId).toBe("kJQP7kiw5Fk");
    });
  }
});

describe("entrees refusees", () => {
  it("refuse un lien qui n est pas YouTube, en le disant", () => {
    const result = parseVideoId("https://vimeo.com/123456789");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("YouTube");
  });

  it("refuse une entree vide", () => {
    expect(parseVideoId("   ").ok).toBe(false);
  });

  it("refuse un identifiant de mauvaise longueur", () => {
    expect(parseVideoId("kJQP7kiw5F").ok).toBe(false);
  });
});
