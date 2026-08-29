import { useRef, useState } from "react";
import { searchVideos, type SearchResult } from "../lib/search";

interface Props {
  /** Ce que fait un resultat choisi. Ajout a la file en room, a la playlist ailleurs. */
  onPick: (result: SearchResult) => void;
  /** Verbe du bouton de chaque ligne, pour dire ou va le morceau. */
  actionLabel: string;
}

type State =
  | { kind: "vide" }
  | { kind: "cherche" }
  | { kind: "resultats"; results: SearchResult[]; query: string }
  | { kind: "panne"; reason: string };

/*
 * Barre de recherche. Elle ne cherche qu a l Entree, jamais a la frappe: chaque appel
 * coute une unite sur un quota d une centaine par jour pour toute l application, et
 * une recherche a chaque lettre le viderait en une phrase.
 */
export function Search({ onPick, actionLabel }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "vide" });
  /*
   * Les resultats se replient. Dix lignes poussent la file hors de l ecran, et une
   * fois le morceau ajoute elles n ont plus rien a dire. Replie plutot qu efface: le
   * compte reste affiche et on les rouvre sans repayer une recherche.
   */
  const [folded, setFolded] = useState(false);
  /*
   * Numero de la derniere recherche lancee. Deux recherches rapides peuvent revenir
   * dans le desordre, et sans ce jeton les resultats de la premiere ecraseraient ceux
   * de la seconde: on afficherait la reponse a une question qu on ne pose plus.
   */
  const latest = useRef(0);

  function run(): void {
    const cleaned = query.trim();
    if (cleaned.length === 0) return;
    const ticket = ++latest.current;
    // Une nouvelle recherche rouvre la liste: on vient de la demander.
    setFolded(false);
    setState({ kind: "cherche" });
    void searchVideos(cleaned).then((outcome) => {
      if (ticket !== latest.current) return;
      setState(outcome.ok
        ? { kind: "resultats", results: outcome.results, query: cleaned }
        : { kind: "panne", reason: outcome.reason });
    });
  }

  return (
    <div className="search">
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cherche un titre, un artiste"
          maxLength={100}
          aria-label="Rechercher sur YouTube"
        />
        <button type="submit" className="btn" disabled={query.trim().length === 0}>
          Chercher
        </button>
      </form>

      {state.kind === "cherche" ? <p className="hint">Recherche en cours...</p> : null}
      {state.kind === "panne" ? <p className="error">{state.reason}</p> : null}

      {state.kind === "resultats" && state.results.length === 0 ? (
        <p className="hint">Rien trouve pour « {state.query} ».</p>
      ) : null}

      {state.kind === "resultats" && state.results.length > 0 ? (
        <div className="results__bar">
          <span className="results__count">
            {state.results.length} resultats pour « {state.query} »
          </span>
          <button
            type="button"
            className="results__fold"
            onClick={() => setFolded((was) => !was)}
            aria-expanded={!folded}
          >
            {folded ? "Afficher" : "Masquer"}
          </button>
        </div>
      ) : null}

      {state.kind === "resultats" && state.results.length > 0 && !folded ? (
        <ul className="results">
          {state.results.map((result) => (
            <li key={result.videoId} className="results__item">
              <span className="results__text">
                <span className="results__title">{result.title}</span>
                <span className="results__channel">{result.channel}</span>
              </span>
              <button
                type="button"
                className="btn results__add"
                onClick={() => onPick(result)}
                aria-label={`${actionLabel} ${result.title}`}
              >
                {actionLabel}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
