import { useEffect, useState } from "react";

interface Props {
  onLeave: () => void;
  /** Vrai quand plus personne d autre n est la: partir emporte la file avec la room. */
  alone: boolean;
}

/*
 * Sortir de la room demande deux clics: le premier arme, le second part.
 *
 * Un clic unique serait trop bon marche pour ce qu il coute. Seul, quitter detruit la
 * room et sa file avec elle; accompagne, on perd au moins sa place dans le morceau en
 * cours et le code de la room si on ne l a pas note. Pas de fenetre de confirmation
 * pour autant: le bouton pose la question la ou on vient de cliquer, et dit lequel
 * des deux cas s applique.
 */
export function LeaveButton({ onLeave, alone }: Props) {
  const [armed, setArmed] = useState(false);

  /*
   * L armement retombe tout seul. Un bouton laisse arme devient un piege pour le clic
   * suivant, qui croira viser "Quitter" et partira sans autre avertissement.
   */
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" className="btn top__leave" onClick={() => setArmed(true)}>
        Quitter
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn top__leave top__leave--armed"
      onClick={onLeave}
    >
      {alone ? "Fermer la room ?" : "Quitter ?"}
    </button>
  );
}
