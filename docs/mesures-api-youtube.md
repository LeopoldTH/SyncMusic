# Mesures de l'API YouTube

Produit par l'unité U1 du plan. Chaque seuil du code renvoie ici ou à une justification écrite dans `client/sync/thresholds.ts`.

**Comment reproduire.** Depuis la racine du projet, servir le banc en HTTP (le lecteur embarqué exige l'en-tête `Referer` depuis juillet 2025, une page ouverte en `file://` renvoie une erreur 153) :

```
python3 -m http.server 8000
```

puis ouvrir `http://localhost:8000/spike/probe.html`.

Mesures du **2026-08-19**, Chrome, machine de développement.

Statut : **trois points sur cinq établis.** Le point 3 n'a pas pu être observé, le point 5 est à refaire après correction du banc.

---

## 1. Cadence des mises à jour de position — ÉTABLI

| Grandeur | Valeur |
|---|---|
| Durée observée | 1046 s |
| Échantillons reçus | 452 |
| Intervalle min | 1 ms |
| Intervalle médian | **266 ms** |
| Intervalle p90 | 269 ms |
| Intervalle max | 7573 ms |

**Plancher de mesure retenu : 300 ms.**

La distribution est très serrée entre le médian et le p90, ce qui donne une cadence de flux nette d'environ 266 ms. Le total est en revanche incohérent avec cette cadence : 452 échantillons sur 1046 secondes donnerait un intervalle moyen de 2,3 secondes. La lecture n'a donc pas été continue sur toute la fenêtre, et le maximum de 7,5 secondes le confirme.

Lecture retenue : **quand les échantillons arrivent, ils arrivent tous les 266 ms**. Les longues interruptions relèvent du point 4 et de la détection de stagnation, pas de la cadence nominale.

Conséquence directe : le plancher est **environ quatre fois plus fin** que la seconde supposée par le plan. La zone morte de correction descend en conséquence, et le seuil entre participants avec elle.

---

## 2. Grille de vitesses acceptées — ÉTABLI

| Grandeur | Valeur |
|---|---|
| Retour de `getAvailablePlaybackRates()` | `[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]` |
| Pas réel de la grille | **0,05** |
| Bornes | 0,25 à 2,00, soit 36 valeurs distinctes |
| Le média suit-il vraiment entre 1,00 et 1,30 | **non vérifié** (contrôle au chronomètre non effectué) |

La grille réellement acceptée est bien plus fine que les huit valeurs annoncées par l'API, qui ne décrivent que le menu de l'interface. `1.05`, `1.15`, `1.35` sont acceptées et relues telles quelles.

**KTD3 est validé sur sa prémisse.** Reste à confirmer en U7, à l'écoute, que le média suit réellement la vitesse annoncée, et que la correction est inaudible sur un morceau chanté.

---

## 3. Comportement pendant une publicité — NON OBSERVÉ

| Grandeur | Valeur |
|---|---|
| Une publicité a-t-elle été observée | non |
| Un événement d'état de publicité est-il émis | indéterminé |
| Identifiants de vidéo traversés | aucun |
| Événements du lecteur pendant la capture | 0 |

Aucune lecture n'a eu lieu pendant la fenêtre de capture, donc la mesure n'a rien à dire. L'absence d'événement d'état de publicité **n'est pas une preuve** : il n'y a pas eu de publicité pour le déclencher.

**Clause de repli du plan appliquée :** la détection de stagnation se validera en U7 par coupure réseau simulée. La détection par symptôme (KD6) reste le socle et ne dépend pas de ce résultat.

---

## 4. Onglet en arrière-plan — ÉTABLI

| Grandeur | Valeur |
|---|---|
| Minuterie demandée | 250 ms |
| Cadence réelle au premier plan | 250 ms (19 ticks) |
| Cadence réelle en arrière-plan | **1000 ms** (61 ticks) |
| Une reprise pilotée fonctionne-t-elle onglet caché | **oui** (état 0 → 1) |

**Cadence de boucle retenue : 1000 ms.** Le ralentissement des minuteries en arrière-plan est confirmé, et c'est le régime nominal du produit puisque l'onglet sera caché pendant les parties. KTD7 tient.

Le second résultat est le plus important du lot : **une lecture démarrée par le code fonctionne alors que l'onglet est caché.** C'est ce qui rend viable la restriction de KTD8, où la porte de visibilité ne s'applique qu'au tout premier démarrage. Sans ce résultat, le produit ne pouvait pas fonctionner dans son seul cas d'usage.

Note : la résolution de mesure (266 ms) et la cadence de décision (1000 ms) sont deux grandeurs distinctes. On mesure plus finement qu'on ne décide.

---

## 5. Précision du positionnement — À REFAIRE

Première tentative invalidée par un défaut du banc de mesure : la vidéo continuait de jouer pendant la seconde et demie d'attente laissée au lecteur pour se stabiliser, si bien que l'écart mesuré était surtout de la lecture normale.

| Cas | Demandé | Lu | Écart brut | Interprétation |
|---|---|---|---|---|
| Zone chargée | 12,345 | 13,879 | +1534 ms | ≈ la durée d'attente : lecture, pas erreur de seek |
| Zone chargée | 20,900 | 22,414 | +1514 ms | idem |
| Loin, `allowSeekAhead=false` | 225,600 | 226,600 | +1000 ms | le saut a bien eu lieu, contrairement à l'attente |
| Loin, `allowSeekAhead=true` | 225,600 | 227,143 | +1543 ms | idem |

Ce que la tentative montre malgré tout : **aucun écart négatif**, donc aucun recalage visible sur une keyframe antérieure, et `allowSeekAhead=false` **a bel et bien effectué le saut** hors zone supposée chargée, alors que la documentation laisse entendre le contraire.

Le banc met désormais la lecture en pause avant de mesurer. **À relancer.**

---

## 6. Seuil audible entre participants — À MESURER (U7)

Ce que ça détermine : la valeur de R13, et par dérivation le plafond au-delà duquel on saute au lieu de corriger par la vitesse. Le plan interdit de le supposer.

**Pourquoi ça ne se déduit pas.** Vous n'êtes pas dans la même pièce. Vous ne percevez aucun déphasage acoustique, seulement un décalage de conversation : l'un réagit à un passage que l'autre n'a pas encore entendu. Votre seuil est donc bien plus large que les 40 à 60 millisecondes que visent les projets de la littérature, et il ne peut venir que de vous.

**Protocole.** Lancez une room à deux, chacun chez soi, en conditions réelles (enceintes habituelles, réglage de latence fait). L'un décale volontairement sa position d'une valeur connue, croissante, et l'autre dit à partir de quand il le remarque en parlant normalement de la musique.

| Décalage imposé | Remarqué par le participant A | Remarqué par le participant B |
|---|---|---|
| 200 ms | | |
| 400 ms | | |
| 600 ms | | |
| 1000 ms | | |
| 1500 ms | | |
| 2500 ms | | |

**Seuil retenu pour R13 :**

**Plafond dérivé pour l'étage saut :**

---

## 7. Audibilité de la correction par vitesse — À MESURER (U7)

Ce que ça détermine : si l'étage intermédiaire tient sa promesse. Les auteurs de Jellyfin ont écrit dans leur propre code que cette correction *sonne mal sur les chansons*, et l'ont désactivée par défaut. C'est la seule prémisse de KTD2 qui reste non vérifiée.

**Protocole.** Sur un morceau chanté, appliquer une correction à chacune des vitesses ci-dessous pendant dix secondes, et noter si elle s'entend.

| Vitesse | Écart qu'elle résorbe en 10 s | S'entend-elle sur du chanté |
|---|---|---|
| 1,05 | 500 ms | |
| 1,10 | 1000 ms | |
| 1,15 | 1500 ms | |
| 1,20 | 2000 ms | |
| 1,25 | 2500 ms | |

**Vitesse maximale jugée acceptable :**

**Conséquence sur la fenêtre de résorption :** si la vitesse acceptable est plus basse que prévu, c'est la fenêtre qu'il faut allonger, pas la correction qu'il faut abandonner.
