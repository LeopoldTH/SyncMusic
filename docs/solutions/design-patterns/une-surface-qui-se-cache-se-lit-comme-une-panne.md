---
title: "Une surface qui se cache par honnêteté se lit comme une panne"
date: 2026-09-14
category: design-patterns
module: client-ui
problem_type: design_pattern
component: frontend
severity: medium
symptoms:
  - "le propriétaire du projet ouvre son propre écran, ne voit pas une section attendue, et conclut que la fonctionnalité est cassée"
  - "un bouton grisé lu comme « ça bug » alors qu'il attend une saisie"
  - "une fonctionnalité jugée et retirée sans avoir jamais été vue à l'écran"
root_cause: unexplained_empty_state
applies_when:
  - "règle de conception qui masque une surface plutôt que de l'afficher à zéro"
  - "classement ou agrégat dont la requête filtre sur une colonne récente, nulle sur les lignes anciennes"
  - "contrôle désactivé tant qu'une condition d'entrée n'est pas remplie"
related_components:
  - data_model
tags:
  - etat-vide
  - honnetete-affichage
  - charte
  - memoire-des-ecoutes
  - onboarding
  - bouton-desactive
  - retour-utilisateur
---

# Une surface qui se cache par honnêteté se lit comme une panne

## Context

La mémoire des écoutes suit une exigence explicite du plan, R9 : ne jamais affirmer plus que ce que les données portent. Concrètement, un classement sans ligne ne se rend pas du tout plutôt que de se rendre à zéro — `if (classement.entries.length === 0) return null;` (client/components/Memoire.tsx:133). La règle est bonne : afficher « Top morceaux : 0 » serait une affirmation fausse sur des données absentes.

Le 14/09/2026, juste après le déploiement de cette fonctionnalité, le propriétaire du projet a ouvert son propre écran `/memoire`. Il n'y a vu ni « Top morceaux » ni « Top artistes ». Il a écrit « je vois pas de miniature ». Il n'y avait pas de miniature parce qu'il n'y avait pas de section.

La cause est dans les requêtes. Le top morceaux filtre sur `WHERE h.user_id = ? AND h.listened_ms IS NOT NULL` (server/db.ts:518) et le top artistes ajoute `AND channel_title IS NOT NULL` (server/db.ts:535). Toutes ses lignes dataient d'avant que la durée et le nom de chaîne existent : zéro ligne éligible, donc zéro section. Seuls les genres survivaient, parce qu'eux se rattrapent après coup depuis le seul identifiant vidéo.

L'écran portait pourtant l'explication, à `client/components/Memoire.tsx:105` : « La mesure des durées commence maintenant : les écoutes déjà enregistrées n'en portent pas. » Elle est dans le bloc des compteurs, en haut. La section manquante est plus bas. Personne n'a fait le lien, y compris la personne qui avait écrit la règle.

## Guidance

**Une surface qui disparaît doit dire pourquoi, à l'endroit où elle manque.** Pas en haut de l'écran, pas dans un bloc voisin : là où l'œil cherche ce qui n'est pas là.

Le choix n'est pas entre « honnête » et « lisible ». Il y a trois états, pas deux :

| État | Ce que l'écran doit faire |
|---|---|
| Des données, au-dessus du seuil | Rendre la surface normalement |
| Des données, sous le seuil | Rendre la surface en disant sur quoi elle porte |
| Aucune donnée éligible | **Rendre un bloc qui nomme la condition manquante**, pas rien |

Le troisième état est celui qui manquait. « Rien » et « pas encore de donnée qui compte ici » se ressemblent à l'écran et ne veulent pas dire la même chose.

Le texte doit nommer la condition, pas l'absence. « Aucun morceau » n'apprend rien. « Les morceaux classés ici sont ceux dont la durée a été mesurée ; tes écoutes d'avant le 14/09 n'en portent pas » se lit comme une explication et non comme une panne.

**Même règle pour un contrôle désactivé.** L'accueil grise « Créer une room » tant que le pseudo est vide (`disabled={!ready}`, client/components/RoomJoin.tsx:51). L'explication existe — « Choisis un pseudo pour commencer. » — mais elle est rendue en toute fin de composant (RoomJoin.tsx:77), après le séparateur « ou » et tout le formulaire de code. Trois blocs séparent le bouton qui refuse de répondre de la phrase qui dit pourquoi. Le propriétaire a écrit « ça bug jpp creer de room ».

**Avant de construire pour une surface, vérifier qu'elle s'affiche chez la personne qui va la juger.** Une requête de trente secondes sur la base répond : est-ce que ses données actuelles remplissent la condition ? Si la réponse est non, la construire revient à livrer dans le noir.

Cette vérification n'est pas appliquée à ce jour : le placement des explications n'a pas été corrigé, et la charte (`docs/design/charte.md`) ne dit rien sur les états vides. C'est un défaut diagnostiqué, pas réparé.

## Why This Matters

Le coût s'est payé trois fois dans une seule session, en montant.

**Une fois en confusion.** Le propriétaire a cru sa propre fonctionnalité cassée, le jour de son déploiement.

**Une fois en fausse piste.** Sur le bouton « Créer une room », le diagnostic a demandé d'ouvrir l'application dans un navigateur pour constater que rien n'était cassé. Le bouton s'active dès qu'un pseudo est tapé ; la room se crée normalement.

**Une fois en travail jeté.** Il a demandé des miniatures dans le top morceaux. Elles ont été implémentées avec leurs tests et leurs styles, puis il a testé, n'a rien vu, et a répondu « enft enleve ca rend pas bien ». Il jugeait une fonctionnalité qu'il n'avait **jamais vue** : la section censée les porter ne s'affichait pas, faute d'écoute avec durée. Le commit a été retiré.

C'est là que l'enjeu dépasse le confort. Un état vide muet ne fait pas que dérouter : il fait prendre des décisions produit sur du vide. Le retrait des miniatures n'était pas un choix esthétique informé, c'était un choix pris devant un écran qui ne montrait rien.

R9 n'est pas en cause et ne doit pas être affaibli. Ce qui manquait, c'est que l'honnêteté sur les données n'implique pas le silence sur la raison.

## When to Apply

- Toute surface dont l'affichage dépend d'un seuil, d'un filtre, ou d'une colonne ajoutée par une migration récente : les lignes antérieures ne la remplissent pas, et c'est l'état normal des premiers jours.
- Tout contrôle désactivé par une condition d'entrée : l'explication va à côté du contrôle, pas en fin de formulaire.
- Avant d'implémenter une amélioration visuelle sur une surface conditionnelle : vérifier d'abord, dans la vraie base de la personne qui jugera, que la surface s'affiche chez elle.
- Ne s'applique pas à un écran entièrement vide, déjà couvert : `/memoire` sans aucune écoute affiche bien un bloc « Pas encore d'écoutes — Écoute un morceau en room : il apparaîtra ici ». Le trou est le vide *partiel*, quand une partie de l'écran vit et qu'une autre s'efface sans rien dire.

## Examples

L'écran `/memoire` du propriétaire, le 14/09/2026, tel qu'il l'a vu :

```
COMPTEURS          3 morceaux · 3 séances
                   « La mesure des durées commence maintenant : les
                     écoutes déjà enregistrées n'en portent pas. »

GENRES ÉCOUTÉS     1  Hip hop music          3 morceaux
                   2  Music of Latin America 1 morceau

SÉANCES            30 août, 29 août, 27 août
```

« Morceaux écoutés » et « Artistes écoutés » sont absents, sans un mot. La phrase qui l'explique est trois blocs plus haut, attachée aux compteurs.

Ce qui l'a levé, côté base :

```json
{"total":17,"avec_duree":0,"avec_artiste":0,"avec_genres":17,"avec_instance":17}
```

Zéro ligne avec durée, zéro avec artiste, donc deux classements sur trois masqués. Les genres, remplis sur les 17 lignes, expliquent pourquoi cette section-là survivait seule et rendait l'absence des deux autres encore plus lisible comme une panne.

Le bouton de l'accueil, dans l'ordre où le composant le rend :

```
[ Créer une room ]          ← disabled tant que le pseudo est vide
――――――― ou ―――――――
[ Code a quatre lettres ] [ Rejoindre ]
« Choisis un pseudo pour commencer. »   ← l'explication, trois blocs plus bas
```

## Related

- [verifier-une-migration-en-prod-sur-fly.md](../workflow-issues/verifier-une-migration-en-prod-sur-fly.md) : même déploiement, même journée. Là-bas on lit un message d'infrastructure comme un échec ; ici on lit un écran silencieux comme une panne. Dans les deux cas le système fait exactement ce qu'on lui a demandé et ne le dit pas.
- Premier learning de conception produit du dépôt : les trois autres docs de `docs/solutions/` portent sur l'outillage et le déploiement, d'où le nouveau répertoire `design-patterns/`.
- `docs/design/charte.md` ne couvre pas les états vides. Recherche faite le 14/09/2026 sur `vide`, `empty`, `absence` : aucune occurrence. C'est la place naturelle d'une règle si elle est adoptée.
