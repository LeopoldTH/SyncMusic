/*
 * Lecture de l historique du compte (U5, KTD8). Meme philosophie que account.ts:
 * une reponse inattendue, un serveur muet ou une session absente valent tous
 * « rien a montrer », jamais un ecran casse.
 */

export interface HistoryEntry {
  videoId: string;
  title: string | null;
  playedAt: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Curseur de la page suivante, null quand tout est charge. */
  nextBefore: string | null;
}

export async function fetchHistory(before?: string): Promise<HistoryPage | null> {
  const url = before === undefined
    ? "/api/history"
    : `/api/history?before=${encodeURIComponent(before)}`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return null;

    const body = payload as { entries?: unknown; nextBefore?: unknown };
    if (!Array.isArray(body.entries)) return null;

    const entries: HistoryEntry[] = [];
    for (const raw of body.entries) {
      const e = raw as { videoId?: unknown; title?: unknown; playedAt?: unknown };
      if (typeof e.videoId !== "string" || typeof e.playedAt !== "number") continue;
      entries.push({
        videoId: e.videoId,
        title: typeof e.title === "string" ? e.title : null,
        playedAt: e.playedAt,
      });
    }
    return { entries, nextBefore: typeof body.nextBefore === "string" ? body.nextBefore : null };
  } catch {
    return null;
  }
}
