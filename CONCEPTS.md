# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Écoute partagée

### Room

Espace d'écoute partagé, rejoint par un code de quatre lettres, où chaque participant regarde la même vidéo au même instant depuis son propre navigateur.

Une room est éphémère et n'existe qu'en mémoire du serveur : elle n'est jamais écrite sur disque, et elle cesse d'exister quand son dernier participant est parti depuis un court délai de grâce. Rien n'en survit, ni la file d'attente, ni la position de lecture. Ce qui survit d'une room appartient à la Mémoire des écoutes, jamais à la room elle-même.

### Séance

Un passage continu d'écoute dans une room, du premier morceau joué jusqu'à la disparition de la room.

*Éviter :* soirée.

Une séance n'est pas un code de room. Le même code peut être réutilisé plus tard pour une room sans rapport, alors la séance est identifiée par l'exécution précise de la room, jamais par son code : deux écoutes séparées de plusieurs jours sous le même code appartiennent à deux séances distinctes. Une séance porte sa date de début, ses Écoutes, et la somme des durées connues de celles-ci.

### Écoute

Une lecture d'un morceau par un compte connecté, dans une Séance.

La durée d'une écoute mesure le temps réellement joué dans la room : les pauses et les attentes de synchronisation en sont exclues, et rejouer le même morceau s'y ajoute. Elle peut être inconnue — une écoute antérieure à la mesure des durées n'en porte aucune, et une durée inconnue ne vaut pas zéro. Un invité ne produit aucune écoute : rien ne s'enregistre pour qui n'est pas connecté.

## Mémoire des écoutes

### Mémoire des écoutes

Ce qu'un compte retrouve de ses Séances passées une fois les rooms disparues : ses compteurs, ses Classements et ses fiches de séance.

Elle n'affirme jamais plus que ce que les données portent. Un total partiel dit sur combien d'écoutes il porte, une surface sans donnée éligible ne se rend pas à zéro, et un Classement ne prend le nom de « top » qu'au-delà de son seuil.

### Classement

Une liste d'Écoutes agrégées et ordonnées — par morceau, par artiste ou par genre — accompagnée de la couverture sur laquelle elle repose.

Un classement ne s'appelle « top » qu'au-delà d'un seuil portant à la fois sur le nombre d'entrées distinctes et sur le nombre d'écoutes derrière elles. Les deux conditions sont nécessaires : un morceau peut porter plusieurs genres, donc compter les étiquettes seules laisserait quelques morceaux fabriquer un faux top. En dessous du seuil, la liste s'affiche quand même, sans le mot.

### Artiste

Le nom de la chaîne qui a publié la vidéo, tenu pour l'artiste du morceau.

C'est une approximation assumée, pas une donnée d'état civil : la chaîne d'un label ou d'un canal officiel porte un nom qui n'est pas exactement celui de l'artiste. Seuls les suffixes que la plateforme ajoute mécaniquement sont retirés ; tout ce qui demanderait de deviner où le nom s'arrête est conservé tel quel.

## Flagged ambiguities

- « soirée » et « séance » ont été employés pour la même chose — le terme retenu est Séance.
- « room » et « séance » ne sont pas la même chose : une room est un espace vivant en mémoire, une séance est la trace durable de ce qui s'y est écouté.
