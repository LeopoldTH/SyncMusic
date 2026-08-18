/*
 * Banc de mesure de l'IFrame Player API de YouTube.
 * Repond aux cinq inconnues de l'unite U1 du plan. Rien ici ne part dans l'application:
 * ce fichier produit des chiffres, et les chiffres vont dans docs/mesures-api-youtube.md.
 *
 * Volontairement en JavaScript simple, sans etape de build: U1 precede l'outillage de U2.
 */

var player = null;
var lines = [];

function say(s) {
  lines.push(s);
  var el = document.getElementById('log');
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}
function head(s) { say(''); say('== ' + s); }
function state(s) { document.getElementById('state').textContent = s; }
function now() { return performance.now(); }
function ms(n) { return Math.round(n) + ' ms'; }
function sleep(d) { return new Promise(function (r) { setTimeout(r, d); }); }

function stats(values) {
  if (!values.length) return null;
  var s = values.slice().sort(function (a, b) { return a - b; });
  return {
    n: s.length,
    min: s[0],
    p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1]
  };
}

/* --- Capture brute du canal postMessage ---------------------------------
 * getCurrentTime() ne demande rien a l'iframe: c'est un cache local alimente par
 * des messages `infoDelivery`. Pour mesurer la vraie cadence il faut ecouter ces
 * messages, pas interroger le lecteur en boucle (on ne lirait que l'extrapolation).
 */
var rawTaps = [];
window.addEventListener('message', function (e) {
  if (typeof e.origin !== 'string' || e.origin.indexOf('youtube.com') === -1) return;
  var data = e.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (err) { return; } }
  if (!data || typeof data !== 'object') return;
  for (var i = 0; i < rawTaps.length; i++) rawTaps[i](data, now());
});

/* --- Cycle de vie du lecteur -------------------------------------------- */

function extractVideoId(raw) {
  var s = (raw || '').trim();
  var m = s.match(/[?&]v=([\w-]{11})/) || s.match(/youtu\.be\/([\w-]{11})/) ||
          s.match(/\/embed\/([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

window.onYouTubeIframeAPIReady = function () {
  state('API chargee. Choisis une video et clique Charger.');
};

function loadVideo() {
  var id = extractVideoId(document.getElementById('videoInput').value);
  if (!id) { state('Identifiant de video illisible.'); return; }
  if (player) { player.loadVideoById(id); state('Video rechargee: ' + id); return; }

  player = new YT.Player('player', {
    videoId: id,
    playerVars: { rel: 0 },
    events: {
      onReady: function () { state('Lecteur pret. Lance la lecture toi-meme.'); },
      onStateChange: function (e) { adLog('onStateChange -> ' + e.data); },
      onApiChange: function () { adLog('onApiChange (module de sous-titres, pas une publicite)'); },
      onError: function (e) {
        say('ERREUR lecteur, code ' + e.data +
            (e.data === 153 ? ' (en-tete Referer absent: sers la page en HTTP, pas en file://)' : ''));
      },
      // Non documente. Deux sources se contredisent sur son existence cote embed:
      // ce banc existe en partie pour trancher.
      onAdStateChange: function (e) { adLog('onAdStateChange -> ' + JSON.stringify(e && e.data)); }
    }
  });
  state('Lecteur en cours de creation...');
}

/* --- 1. Cadence des mises a jour de position ----------------------------- */

var m1 = null;
function m1Start() {
  m1 = { t0: now(), last: null, gaps: [], samples: 0 };
  rawTaps.push(m1Tap);
  document.getElementById('m1Start').disabled = true;
  document.getElementById('m1Stop').disabled = false;
  head('1. Cadence de position: mesure demarree. Laisse jouer dix minutes.');
}
function m1Tap(data, t) {
  if (!m1) return;
  if (data.event !== 'infoDelivery' || !data.info) return;
  if (typeof data.info.currentTime !== 'number') return;
  m1.samples++;
  if (m1.last !== null) m1.gaps.push(t - m1.last);
  m1.last = t;
}
function m1Stop() {
  var s = stats(m1.gaps), dur = (now() - m1.t0) / 1000;
  head('1. Cadence de position');
  say('Duree observee      : ' + dur.toFixed(0) + ' s');
  say('Echantillons recus  : ' + m1.samples);
  if (s) {
    say('Intervalle min      : ' + ms(s.min));
    say('Intervalle median   : ' + ms(s.p50));
    say('Intervalle p90      : ' + ms(s.p90));
    say('Intervalle max      : ' + ms(s.max));
    say('');
    say('=> Le plancher de correction ne peut pas descendre sous le median.');
  } else {
    say('Aucun echantillon: la lecture a-t-elle bien tourne ?');
  }
  rawTaps = rawTaps.filter(function (f) { return f !== m1Tap; });
  m1 = null;
  document.getElementById('m1Start').disabled = false;
  document.getElementById('m1Stop').disabled = true;
}

/* --- 2. Grille de vitesses ----------------------------------------------- */

async function m2Run() {
  if (!player) { say('Charge une video d abord.'); return; }
  head('2. Grille de vitesses acceptees');
  say('getAvailablePlaybackRates() -> ' + JSON.stringify(player.getAvailablePlaybackRates()));
  say('');
  say('demande -> obtenu (seules les transitions sont listees)');

  var prev = null, rows = 0;
  for (var r = 0.25; r <= 2.0001; r += 0.01) {
    var asked = Math.round(r * 100) / 100;
    player.setPlaybackRate(asked);
    await sleep(110);
    var got = player.getPlaybackRate();
    if (got !== prev) { say('  ' + asked.toFixed(2) + ' -> ' + got); prev = got; rows++; }
  }
  player.setPlaybackRate(1);
  say('');
  say('Transitions observees: ' + rows);
  say('=> Le pas de la grille est l ecart entre deux valeurs obtenues successives.');
  say('   A verifier ensuite a l oreille et au chronometre entre 1,00 et 1,30:');
  say('   le lecteur peut accepter la valeur sans que le media suive.');
}

/* --- 3. Publicites -------------------------------------------------------- */

var m3 = null;
function adLog(s) { if (m3) { m3.events.push(s); say('  [evt] ' + s); } }

function m3Start() {
  m3 = { events: [], fields: {}, videoIds: {}, sawAdEvent: false };
  rawTaps.push(m3Tap);
  document.getElementById('m3Start').disabled = true;
  document.getElementById('m3Stop').disabled = false;
  head('3. Publicites: capture demarree. Recharge des videos monetisees.');
}
function m3Tap(data) {
  if (!m3) return;
  if (data.event && String(data.event).toLowerCase().indexOf('ad') !== -1) {
    m3.sawAdEvent = true;
    adLog('message brut contenant "ad": ' + data.event);
  }
  if (data.event !== 'infoDelivery' || !data.info) return;
  // On collecte l'union des champs vus: si un champ n'apparait que pendant une pub,
  // il ressortira ici et c'est exactement le signal qu'on cherche.
  for (var k in data.info) if (Object.prototype.hasOwnProperty.call(data.info, k)) m3.fields[k] = true;
  var vd = data.info.videoData;
  if (vd && vd.video_id) m3.videoIds[vd.video_id] = (m3.videoIds[vd.video_id] || 0) + 1;
}
function m3Stop() {
  head('3. Publicites');
  say('Evenement d etat de publicite observe : ' + (m3.sawAdEvent ? 'OUI' : 'non'));
  say('Identifiants de video traverses      : ' + JSON.stringify(Object.keys(m3.videoIds)));
  say('   (un identifiant inattendu pendant la lecture est un signal de pub)');
  say('Champs vus dans infoDelivery         :');
  say('   ' + Object.keys(m3.fields).sort().join(', '));
  say('Evenements du lecteur                : ' + m3.events.length);
  if (!m3.sawAdEvent) {
    say('');
    say('=> Aucune publicite observee, ou aucun evenement emis. Si aucune pub n a joue,');
    say('   la clause de repli du plan s applique: valider la detection en U7 par');
    say('   coupure reseau simulee plutot que par vraie publicite.');
  }
  rawTaps = rawTaps.filter(function (f) { return f !== m3Tap; });
  m3 = null;
  document.getElementById('m3Start').disabled = false;
  document.getElementById('m3Stop').disabled = true;
}

/* --- 4. Onglet en arriere-plan -------------------------------------------- */

var m4 = null;
function m4Start() {
  m4 = { asked: 250, ticks: [], last: now(), hiddenTicks: [], visibleTicks: [], playWhileHidden: null };
  m4.timer = setInterval(function () {
    var t = now(), gap = t - m4.last;
    m4.last = t;
    (document.hidden ? m4.hiddenTicks : m4.visibleTicks).push(gap);
  }, m4.asked);

  // Une reprise pilotee alors que l onglet est cache: c est le cas d usage reel
  // du produit (partie PS5, onglet en arriere-plan) et le plan en depend.
  m4.probe = setTimeout(function () {
    if (!player || !document.hidden) return;
    var before = player.getPlayerState();
    player.playVideo();
    setTimeout(function () {
      m4.playWhileHidden = { before: before, after: player.getPlayerState() };
    }, 1200);
  }, 20000);

  document.getElementById('m4Start').disabled = true;
  document.getElementById('m4Stop').disabled = false;
  head('4. Arriere-plan: mesure demarree. Change d onglet au moins deux minutes.');
}
function m4Stop() {
  clearInterval(m4.timer); clearTimeout(m4.probe);
  var h = stats(m4.hiddenTicks), v = stats(m4.visibleTicks);
  head('4. Onglet en arriere-plan');
  say('Minuterie demandee   : ' + m4.asked + ' ms');
  say('Au premier plan      : ' + (v ? 'median ' + ms(v.p50) + ' sur ' + v.n + ' ticks' : 'non mesure'));
  say('En arriere-plan      : ' + (h ? 'median ' + ms(h.p50) + ' sur ' + h.n + ' ticks' : 'non mesure (as-tu change d onglet ?)'));
  if (m4.playWhileHidden) {
    say('Reprise onglet cache : etat ' + m4.playWhileHidden.before + ' -> ' + m4.playWhileHidden.after +
        (m4.playWhileHidden.after === 1 ? '  (la lecture a bien demarre)' : '  (la lecture n a PAS demarre)'));
  } else {
    say('Reprise onglet cache : non testee (l onglet etait visible a l instant du test)');
  }
  say('');
  say('=> Si le median en arriere-plan depasse largement la valeur demandee, la boucle');
  say('   de synchronisation doit etre dimensionnee sur cette cadence, pas sur la sienne.');
  rawTaps = rawTaps.filter(function () { return true; });
  m4 = null;
  document.getElementById('m4Start').disabled = false;
  document.getElementById('m4Stop').disabled = true;
}

/* --- 5. Precision du positionnement --------------------------------------- */

async function m5Run() {
  if (!player) { say('Charge une video d abord.'); return; }
  head('5. Precision du positionnement');
  var dur = player.getDuration();
  if (!dur) { say('Duree inconnue: lance la lecture quelques secondes d abord.'); return; }

  /*
   * La lecture doit etre en pause pendant la mesure. Sinon la position avance pendant
   * le temps de stabilisation qu'on laisse au lecteur, et on mesure sa propre attente
   * au lieu de l'erreur de positionnement. C'est le defaut qui a invalide la premiere
   * campagne du 2026-08-19.
   */
  var wasPlaying = player.getPlayerState() === 1;
  player.pauseVideo();
  await sleep(400);

  var cases = [
    { label: 'zone probablement chargee', target: Math.min(12.345, dur - 2), ahead: true },
    { label: 'zone probablement chargee', target: Math.min(20.9, dur - 2), ahead: true },
    { label: 'loin, allowSeekAhead=false', target: Math.max(1, dur * 0.8), ahead: false },
    { label: 'loin, allowSeekAhead=true',  target: Math.max(1, dur * 0.8), ahead: true }
  ];

  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    player.seekTo(c.target, c.ahead);
    await sleep(1600);
    var got = player.getCurrentTime();
    var state = player.getPlayerState();
    say('  demande ' + c.target.toFixed(3) + ' (' + c.label + ') -> lu ' + got.toFixed(3) +
        '   ecart ' + ((got - c.target) * 1000).toFixed(0) + ' ms   [etat ' + state + ']');
  }

  if (wasPlaying) player.playVideo();
  say('');
  say('=> Lecture en pause pendant toute la mesure: l ecart affiche est bien une erreur');
  say('   de positionnement, pas de la lecture normale.');
  say('   Ecart nul = la valeur relue est un echo de la demande, pas une observation.');
  say('   Ecart negatif = recalage sur la keyframe precedente.');
  say('   Un etat different de 2 (pause) invalide la mesure de cette ligne.');
}

/* --- Export ---------------------------------------------------------------- */

function exportReport() {
  var txt = '```\n' + lines.join('\n') + '\n```';
  navigator.clipboard.writeText(txt).then(
    function () { say(''); say('[rapport copie dans le presse-papier, colle-le dans docs/mesures-api-youtube.md]'); },
    function () { say(''); say('[copie refusee par le navigateur: selectionne le texte ci-dessus a la main]'); }
  );
}

/* --- Cablage --------------------------------------------------------------- */

document.getElementById('loadBtn').onclick = loadVideo;
document.getElementById('m1Start').onclick = m1Start;
document.getElementById('m1Stop').onclick = m1Stop;
document.getElementById('m2Run').onclick = m2Run;
document.getElementById('m3Start').onclick = m3Start;
document.getElementById('m3Stop').onclick = m3Stop;
document.getElementById('m4Start').onclick = m4Start;
document.getElementById('m4Stop').onclick = m4Stop;
document.getElementById('m5Run').onclick = m5Run;
document.getElementById('exportBtn').onclick = exportReport;
document.getElementById('clearBtn').onclick = function () { lines = []; say('Efface.'); };
