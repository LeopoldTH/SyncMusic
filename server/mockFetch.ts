/*
 * Support de test: remplacer `fetch` le temps d un fichier de test.
 *
 * Deux fichiers en avaient besoin (videoInfo et history) et en portaient chacun une
 * copie mot pour mot. Une seule definition ici, sinon les deux derivent au premier
 * changement et un test se met a prouver autre chose que son voisin.
 *
 * Ce module n est importe que par des tests. Il vit sous server/ plutot que dans un
 * dossier a part parce que le projet n a pas d autre support de test, et qu un dossier
 * pour un fichier coute plus qu il ne range.
 */

import { vi, afterEach } from "vitest";

const realFetch = globalThis.fetch;

/*
 * Restaure `fetch` apres chaque test. Appele au niveau du fichier, une fois: laisser
 * un fetch mocke fuir vers le fichier suivant rend une suite verte pour de mauvaises
 * raisons, et le coupable est alors introuvable.
 */
export function restoreFetchAfterEach(): void {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });
}

/** Remplace `fetch` par une implementation de test. */
export function mockFetch(impl: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

/** Une reponse 200 portant ce corps en JSON. */
export function jsonOk(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

/** Une reponse vide au statut demande, pour distinguer un refus d une panne (R14). */
export function httpStatus(code: number): () => Promise<Response> {
  return () => Promise.resolve(new Response("", { status: code }));
}
