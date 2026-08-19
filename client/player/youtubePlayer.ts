/*
 * Adaptateur de l IFrame Player API de YouTube.
 *
 * Porte a lui seul les particularites mesurees le 2026-08-19:
 *  - la position lue est un cache local extrapole, plafonne a une seconde;
 *  - une position lue juste apres un positionnement est un echo, pas une mesure;
 *  - la vitesse repasse a 1 au chargement d une video;
 *  - le code d erreur 153 signale un en-tete Referer absent;
 *  - la lecture automatique n est permise que si le lecteur est assez visible.
 */

import type { PlayerFault, PlayerObservation, PlayerPort } from "./playerPort";

/** Le sous-ensemble de l API YouTube dont l adaptateur se sert. */
export interface RawPlayer {
  getCurrentTime(): number;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  loadVideoById(videoId: string): void;
}

export interface AdapterOptions {
  raw: RawPlayer;
  /** Fraction visible du lecteur a l ecran, entre 0 et 1. */
  visibleFraction: () => number;
  /**
   * Vrai des que l utilisateur a interagi avec la page (rejoindre une room, cliquer
   * un controle). Les conditions d utilisation visent une lecture qui demarre sans
   * que personne n ait rien fait, pas une lecture demandee par quelqu un.
   */
  hasUserGesture: () => boolean;
  /** Delai au-dela duquel une position qui n avance plus est declaree gelee. */
  staleAfterMs?: number;
}

const ENDED = 0;
const PLAYING = 1;

export function createYouTubePlayer(options: AdapterOptions): PlayerPort {
  const { raw, visibleFraction, hasUserGesture } = options;
  const staleAfterMs = options.staleAfterMs ?? 1_200;

  let lastPositionMs: number | null = null;
  let lastAdvanceAtMs: number | null = null;
  let echoUntilMs = 0;
  let rateResetPending = false;
  let fault: PlayerFault | null = null;
  let hasStartedOnce = false;
  let playRequestedAtMs: number | null = null;
  let endedPending = false;
  let wasEnded = false;

  return {
    observe(nowMs: number): PlayerObservation {
      const positionMs = raw.getCurrentTime() * 1000;
      const state = raw.getPlayerState();
      const playing = state === PLAYING;

      // Front montant seulement: l etat reste a ENDED tant qu on ne charge rien d autre.
      if (state === ENDED && !wasEnded) endedPending = true;
      wasEnded = state === ENDED;

      // Un ordre de lecture qui n aboutit pas au tour suivant est un refus du
      // navigateur. playVideo() ne rend aucune promesse: c est le seul signal.
      if (playRequestedAtMs !== null && nowMs - playRequestedAtMs > staleAfterMs) {
        if (!playing) fault = { kind: "playback_refused" };
        playRequestedAtMs = null;
      }

      if (lastPositionMs === null || positionMs > lastPositionMs + 1) {
        lastPositionMs = positionMs;
        lastAdvanceAtMs = nowMs;
      }

      const frozen =
        playing && lastAdvanceAtMs !== null && nowMs - lastAdvanceAtMs > staleAfterMs;
      const echo = nowMs < echoUntilMs;

      return { positionMs, playing, fresh: !frozen && !echo };
    },

    seekTo(positionMs: number, nowMs: number): void {
      raw.seekTo(positionMs / 1000, true);
      /*
       * La position relue juste apres vaut exactement la valeur demandee: c est un
       * echo du cache, pas une observation du decodeur. On refuse de la presenter
       * comme une mesure tant que le lecteur ne s est pas stabilise.
       */
      echoUntilMs = nowMs + staleAfterMs;
      lastPositionMs = positionMs;
      lastAdvanceAtMs = nowMs;
    },

    setRate(rate: number): void {
      raw.setPlaybackRate(rate);
    },

    play(opts: { automatic: boolean }, nowMs: number): PlayerFault | null {
      /*
       * La porte ne se ferme que sur une lecture reellement automatique: premiere de
       * la session, sans aucun geste de l utilisateur, et lecteur peu visible.
       *
       * Sans la condition de geste, le cas d usage central du produit ne marche pas:
       * ton pote appuie sur Lecture pendant que ton onglet est derriere le jeu, et
       * ta premiere lecture est refusee alors que tu as toi-meme rejoint la room.
       */
      if (opts.automatic && !hasStartedOnce && !hasUserGesture() && visibleFraction() <= 0.5) {
        return { kind: "not_visible" };
      }
      hasStartedOnce = true;
      playRequestedAtMs = nowMs;
      raw.playVideo();
      return null;
    },

    pause(): void {
      playRequestedAtMs = null;
      raw.pauseVideo();
    },

    load(videoId: string, nowMs: number): void {
      raw.loadVideoById(videoId);
      rateResetPending = true;
      endedPending = false;
      wasEnded = false;
      lastPositionMs = null;
      lastAdvanceAtMs = nowMs;
      echoUntilMs = nowMs + staleAfterMs;
    },

    takeRateReset(): boolean {
      const pending = rateResetPending;
      rateResetPending = false;
      return pending;
    },

    takeEnded(): boolean {
      const pending = endedPending;
      endedPending = false;
      return pending;
    },

    takeFault(): PlayerFault | null {
      const current = fault;
      fault = null;
      return current;
    },
  };
}

/** Traduit un code d erreur du lecteur en panne nommee. */
export function faultFromErrorCode(code: number): PlayerFault {
  if (code === 153) return { kind: "referer_missing" };
  return { kind: "player_error", code };
}
