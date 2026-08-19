interface Props {
  valueMs: number;
  onChange: (valueMs: number) => void;
}

/*
 * Reglage de la latence de sortie (R14, KD8). Une enceinte Bluetooth ajoute 100 a 250 ms
 * entre le moment ou le navigateur joue et celui ou le son sort. Ce retard n est pas
 * mesurable depuis l autre bout du reseau: il se regle a l oreille, une fois.
 */
export function LatencyCalibration({ valueMs, onChange }: Props) {
  return (
    <div className="calibration">
      <label htmlFor="latency">
        Retard de mon enceinte : <strong>{valueMs} ms</strong>
      </label>
      <input
        id="latency"
        type="range"
        min={0}
        max={400}
        step={10}
        value={valueMs}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="hint">
        Si tu entends la musique en retard sur ton pote, augmente. En avance, diminue.
        Le reglage reste sur cet appareil.
      </p>
    </div>
  );
}
