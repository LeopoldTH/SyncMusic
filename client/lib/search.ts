/*
 * Recherche de videos. La cle d API vit sur le serveur et n arrive jamais ici: ce
 * module ne connait que la route interne.
 */

export interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
}

export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  /** Phrase deja lisible, rendue par le serveur: quota, cadence, panne. */
  | { ok: false; reason: string };

function isResult(value: unknown): value is SearchResult {
  const r = value as Partial<SearchResult> | null;
  return typeof r?.videoId === "string"
    && typeof r.title === "string"
    && typeof r.channel === "string";
}

export async function searchVideos(query: string): Promise<SearchOutcome> {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (payload as { error?: unknown } | null)?.error;
      return {
        ok: false,
        reason: typeof message === "string" ? message : "La recherche n a pas abouti.",
      };
    }
    const results = (payload as { results?: unknown } | null)?.results;
    return { ok: true, results: Array.isArray(results) ? results.filter(isResult) : [] };
  } catch {
    // Hors ligne, ou serveur injoignable. Le collage de lien, lui, marche encore.
    return { ok: false, reason: "La recherche n a pas abouti." };
  }
}
