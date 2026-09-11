import { describe, it, expect } from "vitest";
import { classifyYoutubeApiError } from "./youtubeApiError";

/** Un echec de l API YouTube Data v3, le motif porte dans `error.errors[0].reason`. */
function failure(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status });
}

describe("classement d un echec de l API YouTube (revue #2)", () => {
  it("lit un quota epuise dans le motif d un 403", async () => {
    await expect(classifyYoutubeApiError(failure(403, "quotaExceeded"))).resolves.toBe("quota");
  });

  // Un 403 pour une cle mal restreinte n est pas un quota: il ne repart pas demain.
  it("rend une panne pour un 403 d un autre motif", async () => {
    await expect(classifyYoutubeApiError(failure(403, "forbidden"))).resolves.toBe("unavailable");
  });

  it("rend une panne pour un 403 au corps illisible ou de forme inattendue, sans lever", async () => {
    const bodies = [
      "",
      "pas du json",
      "null",
      JSON.stringify({ error: "quotaExceeded" }),
      JSON.stringify({ error: { errors: [] } }),
    ];
    for (const body of bodies) {
      await expect(classifyYoutubeApiError(new Response(body, { status: 403 }))).resolves.toBe("unavailable");
    }
  });

  it("ne lit le motif que sur un 403: tout autre echec est une panne", async () => {
    for (const code of [400, 404, 429, 500, 503]) {
      await expect(classifyYoutubeApiError(failure(code, "quotaExceeded"))).resolves.toBe("unavailable");
    }
  });
});
