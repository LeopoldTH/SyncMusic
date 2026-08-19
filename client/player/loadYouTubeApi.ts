/*
 * Chargement de l IFrame Player API. Le script pose un global et appelle une fonction
 * globale quand il est pret: c est son contrat, on ne peut pas y couper.
 */

interface YTPlayerEvents {
  onReady?: () => void;
  onStateChange?: (event: { data: number }) => void;
  onError?: (event: { data: number }) => void;
}

export interface YTPlayerCtor {
  new (element: string | HTMLElement, config: {
    videoId?: string;
    playerVars?: Record<string, string | number>;
    events?: YTPlayerEvents;
  }): {
    getCurrentTime(): number;
    getPlayerState(): number;
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    setPlaybackRate(rate: number): void;
    loadVideoById(videoId: string): void;
    destroy(): void;
  };
}

declare global {
  interface Window {
    YT?: { Player: YTPlayerCtor };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let pending: Promise<YTPlayerCtor> | null = null;

export function loadYouTubeApi(): Promise<YTPlayerCtor> {
  if (window.YT?.Player) return Promise.resolve(window.YT.Player);
  if (pending) return pending;

  pending = new Promise<YTPlayerCtor>((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      const ctor = window.YT?.Player;
      if (ctor) resolve(ctor);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return pending;
}
