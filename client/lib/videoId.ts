/*
 * Extraction d un identifiant de video YouTube depuis ce qu un humain colle.
 * Pur, donc testable sans navigateur.
 */

export type VideoIdResult =
  | { ok: true; videoId: string }
  | { ok: false; reason: string };

const ID = /^[\w-]{11}$/;

const PATTERNS: RegExp[] = [
  /[?&]v=([\w-]{11})/,          // youtube.com/watch?v=...
  /youtu\.be\/([\w-]{11})/,     // lien court
  /\/embed\/([\w-]{11})/,       // lecteur embarque
  /\/shorts\/([\w-]{11})/,      // format court
  /\/live\/([\w-]{11})/,        // direct
];

export function parseVideoId(raw: string): VideoIdResult {
  const input = raw.trim();
  if (input.length === 0) return { ok: false, reason: "Colle un lien YouTube ou un identifiant." };

  if (ID.test(input)) return { ok: true, videoId: input };

  for (const pattern of PATTERNS) {
    const match = input.match(pattern);
    if (match?.[1]) return { ok: true, videoId: match[1] };
  }

  if (/^https?:\/\//i.test(input)) {
    return { ok: false, reason: "Ce lien ne pointe pas vers une video YouTube." };
  }
  return { ok: false, reason: "Je ne reconnais pas ca comme un lien ou un identifiant YouTube." };
}
