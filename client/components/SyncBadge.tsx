/*
 * L etat de synchronisation, en une ligne lisible d un coup d oeil.
 *
 * C est l element le plus important de l ecran: c est la seule chose que cette
 * application fait et que les autres ne font pas. Il remplace l ancienne barre d etat,
 * qui melangeait un mot technique et un nombre brut.
 */

interface Props {
  connected: boolean;
  waitingFor: string[];
  waitingSinceMs: number | null;
  nowMs: number;
  pairGapMs: number | null;
  /** Au-dela, le decalage devient audible. */
  thresholdMs: number;
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

export function SyncBadge({ connected, waitingFor, waitingSinceMs, nowMs, pairGapMs, thresholdMs }: Props) {
  if (!connected) {
    return (
      <div className="sync sync--off">
        <span className="sync__dot" />
        <span className="sync__label">Hors ligne</span>
        <span className="sync__detail">Reconnexion en cours</span>
      </div>
    );
  }

  if (waitingFor.length > 0) {
    const since = waitingSinceMs === null ? null : seconds(nowMs - waitingSinceMs);
    return (
      <div className="sync sync--wait">
        <span className="sync__dot" />
        <span className="sync__label">On attend {waitingFor.join(" et ")}</span>
        {since === null ? null : <span className="sync__detail">depuis {since}</span>}
      </div>
    );
  }

  if (pairGapMs === null) {
    return (
      <div className="sync">
        <span className="sync__dot" />
        <span className="sync__label">En attente d un second participant</span>
        <span className="sync__detail">Partage le code de la room</span>
      </div>
    );
  }

  const gap = Math.abs(Math.round(pairGapMs));
  const audible = gap > thresholdMs;

  return (
    <div className={audible ? "sync sync--drift" : "sync sync--ok"}>
      <span className="sync__dot" />
      <span className="sync__label">{audible ? "Decalage audible" : "En phase"}</span>
      <span className="sync__detail">
        {gap} ms d ecart{audible ? ` — au-dela des ${thresholdMs} ms tolerees` : ""}
      </span>
    </div>
  );
}
