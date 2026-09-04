/*
 * Ce dont le moteur a besoin d un lecteur, et rien de plus.
 *
 * La frontiere est ici: le moteur ne connait que ce fichier, jamais l API YouTube.
 * Tous les pieges de cette API vivent derriere, dans l implementation (KTD5, KTD6).
 */

export interface PlayerObservation {
  positionMs: number;
  /**
   * Faux quand la valeur lue n est pas une observation: position gelee parce que le
   * lecteur ne rapporte plus rien, ou echo d un positionnement qu on vient de demander.
   * Le moteur ne doit jamais traiter une valeur non fraiche comme une mesure.
   */
  fresh: boolean;
  playing: boolean;
}

export type PlayerFault =
  | { kind: "referer_missing" }        // code 153: en-tete Referer absent
  | { kind: "player_error"; code: number };

export interface PlayerPort {
  observe(nowMs: number): PlayerObservation;
  seekTo(positionMs: number, nowMs: number): void;
  setRate(rate: number): void;
  play(options: { automatic: boolean }, nowMs: number): void;
  pause(): void;
  load(videoId: string, nowMs: number): void;
  /** Le lecteur remet la vitesse a 1 au chargement: le moteur doit le savoir. */
  takeRateReset(): boolean;
  /**
   * Vrai une seule fois, quand le morceau vient de se terminer. Sans ce signal la
   * position cesse d avancer, le detecteur de stagnation se declenche, la barriere
   * rouvre a la position figee et le morceau repart: la file boucle sur son premier titre.
   */
  takeEnded(): boolean;
}
