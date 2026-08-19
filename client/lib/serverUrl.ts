/*
 * Adresse du serveur de rooms. Jamais d adresse locale en dur: U10 depend de ce
 * point, et une valeur codee en dur ne se decouvre qu une fois en ligne.
 */
export function resolveServerUrl(env: Record<string, string | undefined>, location: { protocol: string; host: string }): string {
  const configured = env["VITE_SERVER_URL"];
  if (configured && configured.length > 0) return configured;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}
