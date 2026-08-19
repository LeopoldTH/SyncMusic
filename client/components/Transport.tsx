interface Props {
  playing: boolean;
  disabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export function Transport({ playing, disabled, onPlay, onPause, onNext, onPrevious }: Props) {
  return (
    <div className="transport">
      <button type="button" className="btn" onClick={onPrevious} disabled={disabled} aria-label="Morceau precedent">
        ⏮
      </button>

      {playing ? (
        <button type="button" className="btn btn--primary" onClick={onPause} disabled={disabled}>
          ⏸ Pause
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={onPlay} disabled={disabled}>
          ▶ Lecture
        </button>
      )}

      <button type="button" className="btn" onClick={onNext} disabled={disabled} aria-label="Morceau suivant">
        ⏭
      </button>
    </div>
  );
}
