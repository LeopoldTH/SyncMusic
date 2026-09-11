/*
 * Lecture d un echec de l API YouTube Data v3, commune a la recherche (search.list) et
 * aux genres (videos.list).
 *
 * Revue du 11/09/2026, #2: ce classement vivait en deux copies mot pour mot. Qu une
 * seule derive, et l un des deux chemins lit mal un quota epuise sans rien dire: la
 * recherche annoncerait une panne au lieu du mur du jour, ou le remplissage des genres
 * continuerait de payer des lots que Google refuse.
 */

/**
 * Le motif d un echec, pour une reponse dont le statut n est pas 2xx.
 *
 * 403 couvre aussi bien le quota epuise qu une cle mal restreinte. Seul le premier cas
 * se resorbe tout seul: on lit le motif plutot que de deviner. Tout autre statut est
 * une panne, sans lire le corps.
 */
export async function classifyYoutubeApiError(response: Response): Promise<"quota" | "unavailable"> {
  if (response.status !== 403) return "unavailable";
  const body: unknown = await response.json().catch(() => null);
  const reason = (body as { error?: { errors?: Array<{ reason?: string }> } })
    ?.error?.errors?.[0]?.reason;
  return reason === "quotaExceeded" ? "quota" : "unavailable";
}
