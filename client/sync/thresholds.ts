/*
 * Seuils de synchronisation. Chaque valeur renvoie a une mesure de
 * docs/mesures-api-youtube.md ou porte ici sa justification ecrite.
 */

import type { Thresholds } from "./corrector";

export const SYNC_THRESHOLDS: Thresholds = {
  /*
   * Mesure du 2026-08-19: les positions arrivent toutes les 266 ms (mediane), p90 a
   * 269 ms. Sous ce seuil la valeur lue est extrapolee localement, donc corriger
   * reviendrait a corriger du bruit d API. Arrondi a 300 pour la marge.
   */
  floorMs: 300,

  /*
   * PROVISOIRE. Aucune mesure ne le produit encore: il doit etre derive du seuil
   * audible reel, etabli a l ecoute par le protocole ci-dessous. Valeur d attente
   * inspiree de Jellyfin, qui bascule vers le saut au-dela de 3 s.
   */
  ceilingMs: 3_000,

  /*
   * Duree visee pour resorber un ecart. Longue par choix: personne n attend la
   * correction, et une fenetre courte imposerait des vitesses plus audibles.
   * Deux secondes d ecart se rattrapent ainsi a 1,20x, pas a 2x.
   */
  resorptionWindowMs: 10_000,

  /* Mesure du 2026-08-19: grille reellement acceptee par le lecteur, 36 valeurs. */
  rateStep: 0.05,
  rateMin: 0.25,
  rateMax: 2,
};

/*
 * Mesure du 2026-08-19: en onglet arriere-plan les minuteries tombent a une par
 * seconde. C est le regime nominal du produit, l onglet etant cache pendant les
 * parties. Une boucle plus rapide ne s executerait pas la ou elle sert.
 */
export const LOOP_MS = 1_000;

/*
 * Delai maximum d attente partagee. Non mesure: choisi pour couvrir une publicite
 * non desactivable typique tout en restant supportable. A reevaluer avec les
 * donnees d interruption de R20.
 */
export const MAX_WAIT_MS = 45_000;

/*
 * Delai de grace avant qu un participant qui vient de repartir puisse etre redeclare
 * en stagnation. Non mesure: empeche l oscillation autour de la reprise.
 */
export const STALL_GRACE_MS = 3_000;

/*
 * Age au-dela duquel un rapport de position ne sert plus a mesurer l ecart. Le serveur
 * recale les positions sur un instant commun, mais ce recalage suppose une lecture
 * reguliere: plus le rapport est vieux, plus l hypothese est fragile.
 */
export const STALE_REPORT_MS = 2_000;
