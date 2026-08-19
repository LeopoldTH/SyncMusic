import type { QueueItem } from "../../shared/protocol";

interface Props {
  items: QueueItem[];
  currentItemId: string | null;
  /** Identifiant du participant local, pour ne jamais afficher d identifiant technique. */
  youAre: string;
  onRemove: (itemId: string) => void;
}

/*
 * Les identifiants de participants sont des chaines aleatoires. A deux, il n y a que
 * deux reponses possibles a "qui a ajoute ca", et aucune des deux n est un identifiant.
 */
function who(addedBy: string, youAre: string): string {
  return addedBy === youAre ? "toi" : "ton pote";
}

export function Queue({ items, currentItemId, youAre, onRemove }: Props) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <strong>Rien dans la file</strong>
        Colle un lien YouTube pour lancer quelque chose.
      </div>
    );
  }

  return (
    <ol className="queue">
      {items.map((item, index) => {
        const playing = item.itemId === currentItemId;
        return (
          <li key={item.itemId} className={playing ? "queue__item queue__item--playing" : "queue__item"}>
            <span className="queue__index" aria-hidden="true">{playing ? "▶" : index + 1}</span>

            <span className="queue__text">
              {/* Tant que le titre n est pas revenu, l identifiant tient la place. */}
              <span
                className={item.title === null ? "queue__title queue__title--raw" : "queue__title"}
                title={item.videoId}
              >
                {item.title ?? item.videoId}
              </span>
              <span className="queue__by">ajoute par {who(item.addedBy, youAre)}</span>
            </span>

            {playing ? null : (
              // Le morceau en cours ne peut pas etre retire (R6): le bouton n existe
              // pas, plutot que d exister et d echouer.
              <button
                type="button"
                className="queue__remove"
                onClick={() => onRemove(item.itemId)}
                aria-label={`Retirer ${item.title ?? item.videoId}`}
              >
                Retirer
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
