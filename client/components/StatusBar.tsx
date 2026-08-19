interface Props {
  connected: boolean;
  waitingFor: string[];
  waitingSinceMs: number | null;
  nowMs: number;
  /** Ecart mesure entre les deux participants, en ms. Null tant qu on ne le connait pas. */
  pairGapMs: number | null;
}

function seconds(ms: number): string {
  return Math.max(0, Math.round(ms / 1000)) + " s";
}

export function StatusBar({ connected, waitingFor, waitingSinceMs, nowMs, pairGapMs }: Props) {
  if (!connected) {
    return <div className="status status--warn">Connexion perdue. Tentative de reconnexion.</div>;
  }

  if (waitingFor.length > 0) {
    const who = waitingFor.join(" et ");
    const since = waitingSinceMs === null ? null : seconds(nowMs - waitingSinceMs);
    return (
      <div className="status status--wait">
        En attente de {who}
        {since === null ? "" : ` depuis ${since}`}.
      </div>
    );
  }

  return (
    <div className="status">
      Synchronise
      {pairGapMs === null ? "" : ` — ecart mesure ${Math.round(pairGapMs)} ms`}
    </div>
  );
}
