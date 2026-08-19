/*
 * Conteneur du lecteur YouTube. Les conditions d utilisation imposent un lecteur
 * d au moins 200x200 pixels, jamais recouvert par un autre element, et recommandent
 * 480x270 en 16:9. Rien ne doit etre pose par-dessus.
 */
export function PlayerFrame() {
  return (
    <div className="player">
      <div id="yt-player" className="player__frame" />
    </div>
  );
}
