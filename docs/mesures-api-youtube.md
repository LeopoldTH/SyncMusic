# Mesures de l'API YouTube

Produit par l'unité U1 du plan. Chaque seuil du code renvoie ici ou à une justification écrite dans `client/sync/thresholds.ts`.

**Comment produire ces mesures.** Depuis la racine du projet, servir le banc en HTTP (le lecteur embarqué exige l'en-tête `Referer` depuis juillet 2025, une page ouverte en `file://` renvoie une erreur 153) :

```
python3 -m http.server 8000
```

puis ouvrir `http://localhost:8000/spike/probe.html`.

Statut : **aucune mesure produite à ce jour.** Tant que ce fichier reste vide, les seuils du plan sont provisoires et U7 ne peut pas les figer.

---

## 1. Cadence des mises à jour de position

Ce que ça détermine : le **plancher de correction**. En dessous de cette cadence, la position rapportée est extrapolée localement et corriger revient à corriger du bruit.

Protocole : lecture soutenue de dix minutes, onglet au premier plan.

| Grandeur | Valeur |
|---|---|
| Durée observée | |
| Échantillons reçus | |
| Intervalle médian | |
| Intervalle p90 | |
| Intervalle max | |

**Plancher retenu :**

---

## 2. Grille de vitesses acceptées

Ce que ça détermine : la validité de KTD3, la correction par vitesse à durée calculée.

| Grandeur | Valeur |
|---|---|
| Retour de `getAvailablePlaybackRates()` | |
| Pas réel de la grille | |
| Borne basse / borne haute | |
| Le média suit-il vraiment entre 1,00 et 1,30 (chronomètre) | |

**Si non mesuré :** clause de repli du plan, la grille reste au pas de 0,05 relevé le 2026-08-18 et sa validation passe à l'écoute en U7.

---

## 3. Comportement pendant une publicité

Ce que ça détermine : si la détection d'interruption peut s'appuyer sur un événement, ou seulement sur le symptôme.

| Grandeur | Valeur |
|---|---|
| Une publicité a-t-elle été observée | |
| Un événement d'état de publicité est-il émis | |
| Champs de `infoDelivery` qui changent pendant la pub | |
| Identifiant de vidéo pendant la pub | |

**Si non mesuré :** clause de repli du plan, la détection de stagnation se valide en U7 par coupure réseau simulée. La détection par symptôme (KD6) reste le socle dans tous les cas.

---

## 4. Onglet en arrière-plan

Ce que ça détermine : la cadence de la boucle de synchronisation (KTD7), et si une reprise pilotée fonctionne dans le cas d'usage réel.

| Grandeur | Valeur |
|---|---|
| Minuterie demandée | 250 ms |
| Cadence réelle au premier plan | |
| Cadence réelle en arrière-plan | |
| Une reprise pilotée fonctionne-t-elle onglet caché | |
| La lecture audio se poursuit-elle onglet caché | |

**Cadence de boucle retenue :**

---

## 5. Précision du positionnement

Ce que ça détermine : si le départ commun et l'étage saut peuvent supposer qu'un positionnement atterrit où on le demande.

| Cas | Demandé | Lu après stabilisation | Écart |
|---|---|---|---|
| Zone chargée | | | |
| Loin, `allowSeekAhead=false` | | | |
| Loin, `allowSeekAhead=true` | | | |

**Conclusion sur la relecture après positionnement :**

---

## Rapport brut

Coller ici la sortie du bouton « Copier le rapport » du banc.
