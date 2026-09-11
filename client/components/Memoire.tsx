import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Account } from "../lib/account";
import type {
  ListeningSession, Ranking, Stats, Totals, TopArtist, TopGenre, TopTrack,
} from "../lib/memoire";

interface Props {
  /** `null` pour un invite. App attend la reponse de /api/me avant de monter l ecran. */
  account: Account | null;
  /*
   * `null` tant que /api/stats n a pas repondu. Cette seconde attente compte autant
   * que celle de l identite (R9): sans elle, quelqu un qui a des seances verrait
   * passer l invitation a ecouter entre l arrivee de son nom et celle de ses chiffres.
   */
  stats: Stats | null;
  onMore: () => void;
}

/*
 * Un classement ne s appelle « top » qu a partir de cinq entrees distinctes
 * (Assumption U8, R9). Le compte porte sur les entrees, jamais sur les lignes: vingt
 * ecoutes de deux morceaux passeraient un seuil exprime en lignes et produiraient un
 * « top » a deux entrees, ce que R9 interdit en esprit.
 */
const SEUIL_TOP = 5;

/** Espace fine insecable avant les deux-points (charte Console). */
const FINE = "\u202f";

/* Le mot accorde seul, pour les grands chiffres qui s affichent a part de leur libelle. */
function accord(n: number, singulier: string, pluriel = `${singulier}s`): string {
  return n > 1 ? pluriel : singulier;
}

function compte(n: number, singulier: string, pluriel = `${singulier}s`): string {
  return `${n} ${accord(n, singulier, pluriel)}`;
}

/*
 * Une duree en clair. Jamais « 0 minute »: quand rien n est mesure, l ecran ne rend
 * pas la surface du tout (R9) et cette fonction n est pas appelee. Les secondes
 * restent visibles sous l heure, sinon une soiree de 6 min 30 s afficherait 7 min.
 */
function duree(ms: number): string {
  const secondes = Math.round(ms / 1000);
  if (secondes < 60) return `${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  if (minutes < 60) {
    const reste = secondes % 60;
    return reste === 0 ? `${minutes} min` : `${minutes} min ${String(reste).padStart(2, "0")}`;
  }
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  return reste === 0 ? `${heures} h` : `${heures} h ${String(reste).padStart(2, "0")}`;
}

/*
 * Date et heure de debut d une seance (R8). L heure n est pas un detail: elle separe
 * deux seances du meme jour et garde sa date a une soiree passant minuit.
 */
function debut(startedAt: number): string {
  const date = new Date(startedAt);
  const jour = date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const heure = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${jour} à ${heure}`;
}

/*
 * Les compteurs cumules (R6). Le compteur de temps ne se rend que si une ligne au
 * moins est mesuree, et celui des seances que si une ecoute au moins en porte une:
 * une surface qui ne porte sur aucune ligne n est pas affichee du tout (R9).
 */
function Compteurs({ totals }: { totals: Totals }) {
  const mesureTout = totals.timedTrackCount === totals.trackCount;
  return (
    <section className="panel">
      <div className="panel__head"><h2>Compteurs</h2></div>

      <div className="memoire__compteurs">
        {totals.timedTrackCount === 0 ? null : (
          <div className="memoire__compteur">
            <span className="memoire__valeur">{duree(totals.listenedMs)}</span>
            <span className="memoire__legende">Temps écouté</span>
          </div>
        )}
        <div className="memoire__compteur">
          <span className="memoire__valeur">{totals.trackCount}</span>
          <span className="memoire__legende">{accord(totals.trackCount, "Morceau", "Morceaux")}</span>
        </div>
        {totals.sessionCount === 0 ? null : (
          <div className="memoire__compteur">
            <span className="memoire__valeur">{totals.sessionCount}</span>
            <span className="memoire__legende">{accord(totals.sessionCount, "Séance")}</span>
          </div>
        )}
      </div>

      {totals.timedTrackCount === 0 ? (
        <p className="hint memoire__note">
          La mesure des durées commence maintenant{FINE}: les écoutes déjà enregistrées
          n'en portent pas.
        </p>
      ) : mesureTout ? null : (
        // Un total qui ne couvre pas toutes les lignes dit sur combien il porte (R9).
        <p className="hint memoire__note">
          Durée mesurée sur {compte(totals.timedTrackCount, "morceau", "morceaux")} sur {totals.trackCount}.
        </p>
      )}
    </section>
  );
}

/*
 * La forme commune aux trois classements (R7, R12). Deux gardes d honnetete y vivent:
 * le mot « top » n apparait qu au-dela du seuil, et un classement qui ne couvre pas
 * toutes les ecoutes dit sur combien il est construit (R9).
 */
function Classement<Entry>({ titreTop, titreListe, classement, totalPlays, note, ligne }: {
  titreTop: string;
  titreListe: string;
  classement: Ranking<Entry>;
  /** Toutes les ecoutes enregistrees, ce a quoi la couverture se compare. */
  totalPlays: number;
  note?: string;
  ligne: (entry: Entry, rang: number) => ReactNode;
}) {
  // Aucune entree: pas de module a zero, pas de module du tout (R9).
  if (classement.entries.length === 0) return null;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>{classement.distinctCount >= SEUIL_TOP ? titreTop : titreListe}</h2>
      </div>
      <ol className="memoire__liste">
        {classement.entries.map((entry, index) => ligne(entry, index + 1))}
      </ol>
      {note === undefined ? null : <p className="hint memoire__note">{note}</p>}
      {classement.coveredPlays >= totalPlays ? null : (
        <p className="hint memoire__note">
          Construit sur {compte(classement.coveredPlays, "écoute")} sur {totalPlays}.
        </p>
      )}
    </section>
  );
}

function Seance({ seance }: { seance: ListeningSession }) {
  return (
    <li className="memoire__seance">
      <div className="memoire__entete">
        <span className="memoire__date">{debut(seance.startedAt)}</span>
        <span className="memoire__mesure">{compte(seance.trackCount, "morceau", "morceaux")}</span>
        {/* Aucune ligne mesuree: la seance garde sa date et ses morceaux, sans duree (R9). */}
        {seance.listenedMs === 0 ? null : (
          <span className="memoire__mesure">{duree(seance.listenedMs)}</span>
        )}
      </div>
      <ol className="memoire__morceaux">
        {seance.tracks.map((track, index) => (
          <li key={`${track.playedAt}-${index}`} className="memoire__morceau">
            {/* Tant que le titre n etait pas connu au moment de l ecoute,
                l identifiant tient la place, comme dans la file et l historique. */}
            <span
              className={track.title === null ? "memoire__nom memoire__nom--brut" : "memoire__nom"}
              title={track.videoId}
            >
              {track.title ?? track.videoId}
            </span>
            {track.channelTitle === null ? null : (
              <span className="memoire__artiste">{track.channelTitle}</span>
            )}
            {track.listenedMs === null ? null : (
              <span className="memoire__mesure">{duree(track.listenedMs)}</span>
            )}
          </li>
        ))}
      </ol>
    </li>
  );
}

/*
 * Memoire des ecoutes (U8). L ecran ne charge rien lui-meme: App tient les
 * statistiques et la pagination des seances, comme pour l historique, et ce composant
 * reste testable en chaine.
 *
 * La regle qui gouverne tout l ecran: ne jamais affirmer plus que ce que les donnees
 * portent (R9). Concretement, une surface sans ligne ne se rend pas plutot que de se
 * rendre a zero, un total partiel dit sur quoi il porte, et un classement ne
 * s appelle « top » qu au-dela du seuil.
 */
export function Memoire({ account, stats, onMore }: Props) {
  if (account === null) {
    return (
      <main className="join">
        <h1>Ma mémoire</h1>
        <p className="join__baseline">Connecte-toi pour retrouver ce que tu as écouté.</p>
        <Link className="btn" to="/">Retour à l'accueil</Link>
      </main>
    );
  }

  return (
    <main className="shell memoire">
      <div className="memoire__bandeau">
        <h1 className="memoire__titre">Ma mémoire</h1>
        <Link className="account-bar__link" to="/">Retour à l'accueil</Link>
      </div>

      {stats === null ? (
        <p className="hint">Un instant...</p>
      ) : stats.totals.trackCount === 0 ? (
        <div className="empty">
          <strong>Pas encore d'écoutes</strong>
          Écoute un morceau en room{FINE}: il apparaîtra ici.
        </div>
      ) : (
        <>
          <Compteurs totals={stats.totals} />

          <div className="memoire__grille">
            <Classement<TopTrack>
              titreTop="Top morceaux"
              titreListe="Morceaux écoutés"
              classement={stats.topTracks}
              totalPlays={stats.totals.trackCount}
              ligne={(entry, rang) => (
                <li key={entry.videoId} className="memoire__rang">
                  <span className="memoire__place">{rang}</span>
                  <span
                    className={entry.title === null ? "memoire__nom memoire__nom--brut" : "memoire__nom"}
                    title={entry.videoId}
                  >
                    {entry.title ?? entry.videoId}
                  </span>
                  <span className="memoire__mesure">{duree(entry.listenedMs)}</span>
                </li>
              )}
            />

            <Classement<TopArtist>
              titreTop="Top artistes"
              titreListe="Artistes écoutés"
              classement={stats.topArtists}
              totalPlays={stats.totals.trackCount}
              ligne={(entry, rang) => (
                <li key={entry.channelTitle} className="memoire__rang">
                  <span className="memoire__place">{rang}</span>
                  <span className="memoire__nom">{entry.channelTitle}</span>
                  <span className="memoire__mesure">{duree(entry.listenedMs)}</span>
                </li>
              )}
            />

            <Classement<TopGenre>
              titreTop="Top genres"
              titreListe="Genres écoutés"
              classement={stats.topGenres}
              totalPlays={stats.totals.trackCount}
              /* R12: le pluriel n est pas une coquetterie, un morceau compte dans
                 chacun de ses genres et les nombres ne s additionnent donc pas. */
              note="Un morceau peut compter dans plusieurs genres."
              ligne={(entry, rang) => (
                <li key={entry.genre} className="memoire__rang">
                  <span className="memoire__place">{rang}</span>
                  <span className="memoire__nom">{entry.genre}</span>
                  <span className="memoire__mesure">
                    {compte(entry.trackCount, "morceau", "morceaux")}
                  </span>
                </li>
              )}
            />
          </div>

          {stats.sessions.entries.length === 0 ? null : (
            <section className="panel">
              <div className="panel__head">
                <h2>Séances</h2>
                <span className="panel__count">{compte(stats.totals.sessionCount, "séance")}</span>
              </div>
              <ol className="memoire__seances">
                {stats.sessions.entries.map((seance) => (
                  <Seance key={seance.roomInstanceId} seance={seance} />
                ))}
              </ol>
              {/* Sans ce bouton, les seances au-dela de la premiere page deviennent
                  inatteignables et R8 n est pas tenue. */}
              {stats.sessions.nextBefore === null ? null : (
                <button type="button" className="btn memoire__suite" onClick={onMore}>
                  Voir plus
                </button>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
