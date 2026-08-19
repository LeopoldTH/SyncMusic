interface Props {
  playing: boolean;
  disabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export function Controls({ playing, disabled, onPlay, onPause, onNext, onPrevious }: Props) {
  return (
    <div className="controls">
      <button type="button" onClick={onPrevious} disabled={disabled}>Precedent</button>
      {playing ? (
        <button type="button" onClick={onPause} disabled={disabled}>Pause</button>
      ) : (
        <button type="button" onClick={onPlay} disabled={disabled}>Lecture</button>
      )}
      <button type="button" onClick={onNext} disabled={disabled}>Suivant</button>
    </div>
  );
}
