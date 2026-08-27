interface Props {
  playing: boolean;
  disabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

/* Icones en SVG, jamais en glyphes texte (charte Console): elles suivent la
   couleur du bouton via currentColor et rendent pareil sur toutes les plateformes. */
const IconPrevious = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19 20 L9 12 L19 4 Z"></path>
    <rect x="4" y="4" width="2.6" height="16"></rect>
  </svg>
);

const IconNext = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M5 4 L15 12 L5 20 Z"></path>
    <rect x="17.4" y="4" width="2.6" height="16"></rect>
  </svg>
);

const IconPlay = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 3.5 L21 12 L6 20.5 Z"></path>
  </svg>
);

const IconPause = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="4" width="4" height="16"></rect>
    <rect x="14" y="4" width="4" height="16"></rect>
  </svg>
);

export function Transport({ playing, disabled, onPlay, onPause, onNext, onPrevious }: Props) {
  return (
    <div className="transport">
      <button type="button" className="btn" onClick={onPrevious} disabled={disabled} aria-label="Morceau precedent">
        {IconPrevious}
      </button>

      {playing ? (
        <button type="button" className="btn btn--primary" onClick={onPause} disabled={disabled}>
          {IconPause} Pause
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={onPlay} disabled={disabled}>
          {IconPlay} Lecture
        </button>
      )}

      <button type="button" className="btn" onClick={onNext} disabled={disabled} aria-label="Morceau suivant">
        {IconNext}
      </button>
    </div>
  );
}
