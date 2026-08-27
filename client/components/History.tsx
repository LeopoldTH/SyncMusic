import { Link } from "react-router-dom";
import type { Account } from "../lib/account";
import type { HistoryPage } from "../lib/history";

interface Props {
  /** `null` pour un invite. App attend la reponse de /api/me avant de monter l ecran. */
  account: Account | null;
  /** `null` tant que la premiere page n est pas arrivee. */
  page: HistoryPage | null;
  onMore: () => void;
  /** Instant courant, injecte pour que l affichage relatif des dates soit testable. */
  nowMs: number;
}

/** « aujourd hui », « hier », sinon la date en toutes lettres. */
function playedOn(playedAt: number, nowMs: number): string {
  const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((startOfDay(nowMs) - startOfDay(playedAt)) / 86_400_000);
  if (days <= 0) return "aujourd hui";
  if (days === 1) return "hier";
  return new Date(playedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/*
 * Historique d ecoute (U5). L ecran ne charge rien lui-meme: App tient la page et la
 * pagination, comme pour le compte, et ce composant reste testable en chaine.
 */
export function History({ account, page, onMore, nowMs }: Props) {
  if (account === null) {
    return (
      <main className="join">
        <h1>Mon historique</h1>
        <p className="join__baseline">Connecte-toi pour retrouver ce que tu as ecoute.</p>
        <Link className="btn" to="/">Retour a l accueil</Link>
      </main>
    );
  }

  return (
    <main className="join history">
      <h1>Mon historique</h1>
      <p className="join__baseline">Ce que tu as ecoute en room, du plus recent au plus ancien.</p>

      {page === null ? (
        <p className="hint">Un instant...</p>
      ) : page.entries.length === 0 ? (
        <div className="empty">
          <strong>Pas encore de donnees</strong>
          Ecoute un morceau en room: il apparaitra ici.
        </div>
      ) : (
        <>
          <ol className="history__list">
            {page.entries.map((entry, index) => (
              <li key={`${entry.playedAt}-${index}`} className="history__item">
                {/* Tant que le titre n etait pas connu au moment de l ecoute,
                    l identifiant tient la place, comme dans la file. */}
                <span
                  className={entry.title === null ? "history__title history__title--raw" : "history__title"}
                  title={entry.videoId}
                >
                  {entry.title ?? entry.videoId}
                </span>
                <span className="history__when">{playedOn(entry.playedAt, nowMs)}</span>
              </li>
            ))}
          </ol>
          {page.nextBefore === null ? null : (
            <button type="button" className="btn" onClick={onMore}>Voir plus</button>
          )}
        </>
      )}

      <Link className="account-bar__link" to="/">Retour a l accueil</Link>
    </main>
  );
}
