import { useEffect } from "react";

interface Props {
  /**
   * Signale la presence du cadre a l ecran. C est le seul moyen fiable de savoir
   * quand le lecteur doit naitre et quand il doit mourir: l API YouTube remplace le
   * div ci-dessous par son iframe, et React emporte le tout en demontant la vue.
   */
  onMountedChange: (mounted: boolean) => void;
}

/*
 * Conteneur du lecteur YouTube. Les conditions d utilisation imposent un lecteur
 * d au moins 200x200 pixels, jamais recouvert par un autre element, et recommandent
 * 480x270 en 16:9. Rien ne doit etre pose par-dessus.
 */
export function PlayerFrame({ onMountedChange }: Props) {
  useEffect(() => {
    onMountedChange(true);
    return () => onMountedChange(false);
  }, [onMountedChange]);

  return (
    <div className="player">
      <div id="yt-player" className="player__frame" />
    </div>
  );
}
