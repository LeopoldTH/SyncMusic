import { useState } from "react";
import { Link } from "react-router-dom";
import type { Account } from "../lib/account";
import type { Playlist, PlaylistItem } from "../lib/playlists";
import type { HistoryEntry } from "../lib/history";

/** Ce que l ecran montre de l historique recent: assez pour piocher, pas une page entiere. */
const RECENT_SHOWN = 10;

interface Props {
  /** `null` pour un invite. App attend la reponse de /api/me avant de monter l ecran. */
  account: Account | null;
  /** `null` tant que la liste n est pas arrivee. */
  playlists: Playlist[] | null;
  selectedId: number | null;
  /** Contenu de la playlist selectionnee, `null` le temps du chargement. */
  items: PlaylistItem[] | null;
  /** Ecoutes recentes, source d ajout (R8). `null` tant que rien n est arrive. */
  recent: HistoryEntry[] | null;
  error: string | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  /** Recoit le lien brut: App le valide par videoId.ts et porte le message d erreur. */
  onAddLink: (link: string) => void;
  onAddEntry: (entry: HistoryEntry) => void;
}

/*
 * Ecran playlists (U6). Comme History: aucune requete ici, App tient les donnees et
 * les actions, l ecran reste testable en chaine. Seuls les brouillons de saisie et la
 * selection visuelle vivent localement.
 */
export function Playlists({
  account, playlists, selectedId, items, recent, error,
  onSelect, onCreate, onAddLink, onAddEntry,
}: Props) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");

  if (account === null) {
    return (
      <main className="join">
        <h1>Mes playlists</h1>
        <p className="join__baseline">Connecte-toi pour preparer des playlists.</p>
        <Link className="btn" to="/">Retour a l accueil</Link>
      </main>
    );
  }

  const selected = playlists?.find((p) => p.id === selectedId) ?? null;

  return (
    <main className="join playlists">
      <h1>Mes playlists</h1>
      <p className="join__baseline">Prepare des morceaux a envoyer d un coup dans une room.</p>

      <form
        className="playlists__create"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length === 0) return;
          onCreate(trimmed);
          setName("");
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom de la playlist"
          maxLength={100}
          aria-label="Nom de la playlist"
        />
        <button type="submit" className="btn" disabled={name.trim().length === 0}>Creer</button>
      </form>

      {playlists === null ? (
        <p className="hint">Un instant...</p>
      ) : playlists.length === 0 ? (
        <div className="empty">
          <strong>Pas encore de playlist</strong>
          Cree-en une, puis remplis-la d un lien colle ou depuis ton historique.
        </div>
      ) : (
        <ul className="playlists__list">
          {playlists.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={p.id === selectedId ? "playlists__pick playlists__pick--active" : "playlists__pick"}
                onClick={() => onSelect(p.id)}
              >
                <span className="playlists__name">{p.name}</span>
                <span className="playlists__count">
                  {p.itemCount === 0 ? "vide" : `${p.itemCount} morceau${p.itemCount > 1 ? "x" : ""}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected === null ? null : (
        <section className="playlists__detail">
          <h2>{selected.name}</h2>

          {items === null ? (
            <p className="hint">Un instant...</p>
          ) : items.length === 0 ? (
            <p className="hint">Rien dedans pour l instant.</p>
          ) : (
            <ol className="history__list">
              {items.map((item, index) => (
                <li key={`${item.videoId}-${index}`} className="history__item">
                  <span
                    className={item.title === null ? "history__title history__title--raw" : "history__title"}
                    title={item.videoId}
                  >
                    {item.title ?? item.videoId}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <form
            className="add"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim().length === 0) return;
              onAddLink(link);
              setLink("");
            }}
          >
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Colle un lien YouTube"
              aria-label="Lien YouTube"
            />
            <button type="submit" className="btn">Ajouter</button>
          </form>

          {recent === null || recent.length === 0 ? null : (
            <div className="playlists__recent">
              <h3>Depuis ton historique</h3>
              <ul className="history__list">
                {recent.slice(0, RECENT_SHOWN).map((entry, index) => (
                  <li key={`${entry.playedAt}-${index}`} className="history__item">
                    <span
                      className={entry.title === null ? "history__title history__title--raw" : "history__title"}
                      title={entry.videoId}
                    >
                      {entry.title ?? entry.videoId}
                    </span>
                    <button type="button" className="btn playlists__add" onClick={() => onAddEntry(entry)}>
                      Ajouter
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {error === null ? null : <p className="error">{error}</p>}

      <Link className="account-bar__link" to="/">Retour a l accueil</Link>
    </main>
  );
}

/*
 * Selecteur d envoi, dans la room (R9). Sans playlist, il dit ou en creer une; le lien
 * quitte l ecran de room, ce que le plan assume (KD7 ne vise que la connexion).
 */
export function SendPlaylist({
  playlists, onSend,
}: { playlists: Playlist[] | null; onSend: (id: number) => void }) {
  const [chosen, setChosen] = useState<number | null>(null);

  if (playlists === null) return null;
  if (playlists.length === 0) {
    return (
      <p className="hint send-playlist__none">
        Pas encore de playlist — <Link className="account-bar__link" to="/playlists">en creer une</Link>
      </p>
    );
  }

  const value = chosen ?? playlists[0]?.id ?? 0;
  return (
    <form
      className="send-playlist"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(value);
      }}
    >
      <select
        value={value}
        onChange={(e) => setChosen(Number(e.target.value))}
        aria-label="Playlist a envoyer"
      >
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.itemCount})
          </option>
        ))}
      </select>
      <button type="submit" className="btn">Envoyer dans la file</button>
    </form>
  );
}
