import type { QueueItem } from "../../shared/protocol";

interface Props {
  items: QueueItem[];
  currentItemId: string | null;
  onRemove: (itemId: string) => void;
}

export function Queue({ items, currentItemId, onRemove }: Props) {
  if (items.length === 0) {
    return (
      <div className="queue queue--empty">
        <p>La file est vide.</p>
        <p className="hint">Colle un lien YouTube pour lancer quelque chose.</p>
      </div>
    );
  }

  return (
    <ol className="queue">
      {items.map((item) => {
        const playing = item.itemId === currentItemId;
        return (
          <li key={item.itemId} className={playing ? "queue__item queue__item--playing" : "queue__item"}>
            <span className="queue__title">{item.videoId}</span>
            {playing ? (
              <span className="queue__badge">en cours</span>
            ) : (
              // Le morceau en cours ne peut pas etre retire (R6): le bouton n existe
              // pas, plutot que d exister et d echouer.
              <button type="button" onClick={() => onRemove(item.itemId)}>
                Retirer
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
