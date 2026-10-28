# Règles de détection – Commentaire Rocket League

Toutes les règles s'appuient uniquement sur l'API Stats officielle (pas de position des voitures).
Les seuils marqués ⚙️ sont des valeurs de départ à ajuster après quelques matchs.

## Repères tirés de l'API

| Info | Source | Remarque |
|---|---|---|
| Position de la balle | `BallHit.Ball.Location` | Uniquement au moment d'une touche |
| Vitesse de la balle | `BallHit.Ball.PreHitSpeed / PostHitSpeed`, `GoalScored.GoalSpeed` | En km/h |
| Qui touche | `BallHit.Players[]` | Peut contenir 2 joueurs (touche simultanée) |
| Tir cadré | `StatfeedEvent` `EventName = "Shot"` | Envoyé ~0,1 s après la touche : c'est **le jeu** qui a calculé que la balle allait au but |
| Stats joueurs | `UpdateState.Players[]` | `Score, Goals, Assists, Saves, Shots, Touches, Boost, bOnWall, bOnGround…` |
| Clé absente | `UpdateState` | Une clé manquante = `false` / `0` (ex. `Boost` absent = 0 boost) |
| Chrono | `UpdateState.Game.TimeSeconds` + `bOvertime` | Temps restant ; en prolongation, temps écoulé |
| Score | `UpdateState.Game.Teams[].Score` | |
| Mode | `UpdateState.Game.PlaylistId` | 10 = 1v1, 11 = 2v2, 13 = 3v3 classés (sinon : compter les joueurs par équipe) |
| MVP | `StatfeedEvent` `EventName = "MVP"` | Envoyé en fin de match |

**Terrain** : lignes de but à Y = ±5120. L'équipe **0 (bleue) attaque vers +Y**, l'équipe 1 (orange) vers −Y.
Cage : X entre −893 et +893, hauteur 643. Rayon de la balle ≈ 93.
« Distance au but adverse » d'une touche = `5120 − Y` pour les bleus, `5120 + Y` pour les orange.

**Doublon de but** : chaque but envoie 2 `GoalScored`. Le 1er (avec `Scorer.Name`) déclenche les règles ;
le 2e (pendant le replay, `Scorer.Name` vide) contient le **bon** `ImpactLocation` (celui du 1er est parfois celui du but précédent).

---

## 1. Tap-in 🥱
**Idée** : le buteur n'a fait que pousser une balle servie sur un plateau.

**Règle** — sur `GoalScored` :
- Dernière touche du buteur à **≤ 900** de la ligne adverse et **|X| ≤ 1200** ⚙️
- Balle après sa touche **≤ 50 km/h** ⚙️
- Un **coéquipier** a touché la balle **≤ 2 s** avant ⚙️, sans touche adverse entre-temps qui ait relancé l'action
- Le buteur a fait **≤ 2 touches** dans l'action

**Cible** : le buteur. **Quand** : pendant le replay.

## 2. Vol de but 🦹
**Idée** : la balle rentrait toute seule, un coéquipier l'a touchée pour se l'attribuer.

**Réponse à la question** : oui, on peut le savoir de façon fiable grâce au `Shot` du jeu. Quand une touche
part cadrée, le jeu envoie `Shot` dans la foulée ; on n'a pas à refaire la physique nous-mêmes.

**Règle** — sur `GoalScored` (buteur S) :
- Un coéquipier A a touché la balle et un `Shot` de A a suivi **≤ 0,3 s** après cette touche
- Entre cette touche de A et le but : **aucune touche adverse**, seulement des touches de S
- Les touches de S sont à **≤ 1500** de la ligne ⚙️ (on ne parle pas d'un relais au milieu du terrain)
- Bonus « vol à l'arraché » : S a **ralenti** la balle (`PostHitSpeed < PreHitSpeed`)

**Cible** : S (le voleur), en citant A. **Quand** : pendant le replay.
_Exemple réel_ : un but en prolongation n'est **pas** un vol — le dernier tir cadré du coéquipier date de 2,4 s,
et sa dernière touche (0,7 s avant) n'était pas cadrée.

## 3. Arrêt manqué 🧤
**Idée** : un défenseur touche la balle juste avant qu'elle rentre.

**Règle** — sur `GoalScored` :
- Un joueur de l'équipe **qui encaisse** a touché la balle **≤ 1 s** avant le but ⚙️
- Touche à **≤ 1500** de sa propre ligne ⚙️
- Deux variantes :
  - **« Accompagné »** : un `Shot` adverse existait déjà, ou l'attaquant a touché la balle à **≤ 1000** de la ligne → la balle rentrait, il l'a juste escortée
  - **« But contre son camp »** : pas de `Shot` adverse depuis la dernière touche adverse → c'est lui qui l'a mise

**Cible** : le défenseur. **Quand** : pendant le replay.
_Exemple réel_ : un défenseur adverse a touché la balle 0,2 s avant un but en prolongation.

## 4. Lucarne 🎯
**Règle** — sur le `GoalScored` du replay (le 2e, pour un `ImpactLocation` fiable) :
- **Z ≥ 450** et **|X| ≥ 550** ⚙️
- Variante « au ras du sol » : **Z ≤ 110** (balle qui roule) et **≤ 60 km/h** ⚙️
- Uniquement si aucune autre règle n'a commenté le but (on attend le replay pour avoir le bon point d'impact)

**Cible** : le buteur (compliment ironique ou vrai compliment). **Quand** : fin du replay.
⚠️ À valider sur plus de buts (le bon `ImpactLocation` est celui du replay).

## 5. Passe décisive administrative 📎
**Idée** : la passe a été comptée mais n'y est pour rien.

**Règle** — sur `GoalScored` avec `Assister` :
- Dernière touche du passeur → but : **≥ 4 s** ⚙️
- **ou** le buteur a fait **≥ 3 touches** entre la passe et le but (il a tout fait seul)
- **ou** une touche adverse a eu lieu entre la passe et la touche du buteur

**Cible** : le passeur. **Quand** : pendant le replay.

## 6. MVP illégitime 👑
**Idée** : un MVP fait de coups d'éclat et de chance, sans travail derrière.

**Règle** — sur `StatfeedEvent` `MVP`, avec les stats finales de `UpdateState` + l'historique du match :
- **Part des points venant des faits marquants** : `(100 × Goals + 50 × Assists) / Score` **≥ 70 %** ⚙️
- **Peu de travail** : `Touches` **≤ moyenne de son équipe** et `Saves = 0` ⚙️
- **Au moins 1 casserole** dans le match : un de ses buts est un **tap-in** ou un **vol**, ou une de ses passes est **administrative**, ou il a un **arrêt manqué**
- Plus il cumule de casseroles, plus le commentaire est appuyé (le curseur) :
  - 1 casserole → pique légère
  - 2 → franchement moqueur
  - 3+ → « remboursez le MVP »

**Cible** : le MVP, en citant le coéquipier qui a le plus de touches (« le vrai MVP »). **Quand** : `PodiumStart`.

## 7. Le mendiant 🪙
**Idée** : sans boost trop longtemps quand ça n'a pas de sens.

**Limite** : on ne connaît **pas** la position des voitures. On utilise ce qu'on a :
`bOnWall` (mur ou backboard), la vitesse, et la position de la balle à la dernière touche.

**Règle** — sur `UpdateState`, pendant le jeu (pas en replay, pas au compte à rebours) :
- `Boost` à 0 (ou absent) **en continu pendant ≥ 8 s** ⚙️
- **Exclusions** (le boost à 0 est normal ou excusable) :
  - le joueur est sur un mur / le backboard (`bOnWall`) pendant la période
  - il vient de **faire une touche** (il est en train de jouer l'action)
  - les 10 s qui suivent un engagement
- **Aggravant** (déclenche plus vite, ⚙️ 5 s) : la dernière touche de balle est dans **son propre tiers**
  (son équipe est sous pression et il est à sec)

**Cible** : le joueur. **Quand** : en direct. **Anti-spam** : 1 fois par joueur toutes les 90 s.

## 8. Le fantôme 👻
**Idée** : pas de contribution utile depuis trop longtemps (toucher la balle ne suffit pas).

**Action utile** = au moins une des conditions :
- la touche suivante est faite par **son équipe** (il a gardé ou donné la balle)
- le jeu lui donne **≥ 10 points** d'un coup : centre (+10), dégagement ou tir cadré (+20), arrêt (+50), arrêt miraculeux (+75), but (+100)… Une simple touche ne rapporte que +2 et ne compte pas ⚙️
- le jeu lui attribue un `Shot`, `Save`, `EpicSave`, `Savior`, `Goal`, `Assist` ou une **démo** (`Demolish`)

Une balle poussée vers l'avant puis perdue, sans points du jeu, ne compte pas : c'est souvent une balle rendue.

**Règle** — en direct :
- Aucune touche utile depuis **≥ 45 s en 3v3**, **≥ 40 s en 2v2** ⚙️ (pas de fantôme en 1v1)
- On ne compte que le temps de jeu effectif (pas les replays ni les comptes à rebours)

**Cible** : le joueur. **Quand** : en direct. **Anti-spam** : 1 fois par joueur toutes les 2 min, et au moins 1 min entre deux fantômes. Le chrono s'arrête au but et repart de zéro à chaque coup d'envoi.

## 9. Craquage 💥
**Idée** : le but qui fait mal, au pire moment, avec une erreur défensive.

**Règle** — sur `GoalScored`, **toutes** les conditions :
- Il reste **≤ 10 s** de temps réglementaire (`TimeSeconds ≤ 10`, `bOvertime = false`)
- Le but **change l'issue** : égalisation, ou l'équipe qui marque passe devant
- Il y a un **arrêt manqué** (règle 3) sur ce but

**Cible** : le défenseur de l'arrêt manqué. **Quand** : pendant le replay — **remplace** le commentaire d'arrêt manqué.
_Option_ : appliquer aussi aux buts en prolongation (ils changent toujours l'issue).

## 10. Le bénévole 🎁
**Idée** : il rend la balle à l'adversaire sans aucune pression, et ça part en contre.

**Pourquoi ces filtres** : sur un match 3v3 classé, 77 des 127 changements de possession sont
« touche → récupération adverse à distance ». C'est surtout des attaques qui finissent chez le gardien
adverse : normal, pas un cadeau. On ne garde que les balles rendues **vers l'arrière** qui coûtent quelque chose.

**Règle** — touche du joueur P (équipe A), touche suivante par un adversaire R (équipe B) :
- **Pas un duel** : écart **≥ 1 s** et **≥ 1500** de distance entre les deux touches ⚙️
- **Balle rendue vers chez soi** : R récupère la balle **plus près du but de P** que là où P l'a touchée (recul **≥ 800**) ⚙️,
  ou directement **dans la moitié de terrain de P**
- **Pas une excuse** :
  - la touche de P n'est pas un dégagement depuis son tiers défensif (touche à **≥ 2500** de sa ligne)
  - la touche de P n'est pas un tir cadré (`Shot`) arrêté
- **Récupération propre** : la touche d'après est aussi faite par l'équipe B
- **Ça coûte** : `Shot` ou `Goal` de l'équipe B **≤ 6 s** après la récupération ⚙️

**Paliers** : `Shot` adverse → « bénévole » ; but adverse → « bénévole de l'année » (le commentaire du but le cite).
**Sans tir** : si la balle est renvoyée d'au moins **15 m vers son propre but** (`giveawayBackwardNoShot`) et récupérée proprement,
le bot le dit quand même (« balle rendue »), dès que son équipe récupère la balle ou au bout de 6 s.
**Cible** : P. **Quand** : au `Shot` adverse (en direct) ou pendant le replay du but.
**Fréquence attendue** : ~2-3 par match en 3v3 (mesuré sur la capture : 3 cas).
**Limite** : sans position des voitures, on ne sait pas si c'était une passe vers un coéquipier mal placé
(le cadeau est alors partagé). En fin de match, on peut aussi annoncer le **« bénévole du match »** (le plus de ballons rendus, même sans tir).

---

## Qui est commenté

Par défaut (`target: "our-team"` dans config.json), seul **notre équipe** se fait chambrer : l'équipe où joue au moins un pseudo de la liste des surnoms.
Le joueur visé (buteur du tap-in, voleur, défenseur de l'arrêt manqué, passeur, MVP, mendiant, fantôme, bénévole) doit en faire partie.
Les adversaires peuvent être cités (ex. celui qui marque après un cadeau), mais ne sont jamais la cible.

## Priorités (1 seul commentaire par but)

Si plusieurs règles se déclenchent sur le même but, on garde la plus piquante parmi celles qui visent un joueur de notre équipe :
**Craquage > Vol de but > Bénévole de l'année > Arrêt manqué > Tap-in > Passe administrative > Lucarne**

Les règles en direct (mendiant, fantôme, bénévole) ne parlent jamais pendant un replay, et laissent
**≥ 15 s** entre deux commentaires.

## Non retenu
- Double commit (on ne voit pas les touches ratées)
- Rotation / dernier défenseur (pas de position des voitures)
