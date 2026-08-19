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
  /** Delai au-dela duquel une position qui n avance plus est declaree gelee. */
  staleAfterMs?: number;
}

const PLAYING = 1;

export function createYouTubePlayer(options: AdapterOptions): PlayerPort {
  const { raw, visibleFraction } = options;
  const staleAfterMs = options.staleAfterMs ?? 1_200;

  let lastPositionMs: number | null = null;
  let lastAdvanceAtMs: number | null = null;
  let echoUntilMs = 0;
  let rateResetPending = false;
  let fault: PlayerFault | null = null;
  let hasStartedOnce = false;
  let playRequestedAtMs: number | null = null;

  return {
    observe(nowMs: number): PlayerObservation {
      const positionMs = raw.getCurrentTime() * 1000;
      const playing = raw.getPlayerState() === PLAYING;

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
       * La porte de visibilite ne s applique qu au tout premier demarrage de session,
       * le seul qui soit une lecture automatique au sens des conditions d utilisation.
       * Une reprise pilotee ensuite fonctionne onglet cache: mesure du 2026-08-19,
       * etat 0 -> 1. Sans cette restriction, un onglet en arriere-plan resterait
       * indefiniment non pret et aucune barriere ne se fermerait jamais.
       */
      if (opts.automatic && !hasStartedOnce && visibleFraction() <= 0.5) {
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
      lastPositionMs = null;
      lastAdvanceAtMs = nowMs;
      echoUntilMs = nowMs + staleAfterMs;
    },

    takeRateReset(): boolean {
      const pending = rateResetPending;
      rateResetPending = false;
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
