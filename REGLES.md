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
**Idée** : le buteur n'avait plus rien à faire, il a touché la balle tout près du but. Pas besoin de passe.

**Règle** — sur `GoalScored` :
- Dernière touche du buteur à **≤ 9 m** de la ligne adverse (`tapInMaxDistance`) et à **≤ 12 m** du centre sur le côté (`tapInMaxSideOffset`) ⚙️
- Touchée **pas haut** : balle à **≤ 2,5 m** du sol au moment de la touche (`tapInMaxTouchHeight`) ⚙️ (une reprise aérienne demande un vrai geste)
- Un défenseur qui la touche après sans l'arrêter ne change rien

**Cible** : le buteur. **Quand** : pendant le replay.
Fréquence mesurée : 19 sur 34 matchs complets (les deux équipes).

## 2. Vol de but 🦹
**Idée** : la balle rentrait toute seule, un coéquipier l'a touchée pour se l'attribuer.

**Réponse à la question** : oui, on peut le savoir de façon fiable grâce au `Shot` du jeu. Quand une touche
part cadrée, le jeu envoie `Shot` ; on n'a pas à refaire la physique nous-mêmes.

**Règle** — sur `GoalScored` (buteur S) :
- Un coéquipier A a touché la balle et le jeu a annoncé un **tir cadré** (`Shot`) de A : la balle allait au but.
  Le jeu l'annonce souvent tard (la moitié du temps plus de 0,5 s après la touche, parfois après la touche suivante) :
  on accepte un `Shot` jusqu'à **2 s** après la touche de A (`stealShotWindowMs`), et avant le but ⚙️
- Entre cette touche de A et le but : **aucune touche adverse**, seulement des touches de S
- Les touches de S sont à **≤ 15 m** de la ligne (`stealMaxDistance`) ⚙️ : il la touche au dernier moment, devant la cage

**Cible** : S (le voleur), en citant A. **Quand** : pendant le replay.
Fréquence mesurée : 8 sur 39 matchs enregistrés (3 avec l'ancienne fenêtre de 0,3 s).
_Exemple réel_ : un but en prolongation n'est **pas** un vol — le dernier tir cadré du coéquipier date de 2,4 s,
et sa dernière touche (0,7 s avant) n'était pas cadrée.

## 3. Contre son camp 🙃
**Idée** : la balle ne rentrait pas, et c'est un joueur de l'équipe qui encaisse qui l'a mise dans sa propre cage.
(Remplace l'arrêt manqué : savoir si un arrêt était faisable est trop incertain.)

**Règle** — sur `GoalScored` :
- La **dernière touche** avant le but est celle d'un joueur de l'équipe **qui encaisse** (seul, pas un duel), **≤ 3 s** avant le but (`ownGoalMaxMs`) ⚙️
- La balle **ne rentrait pas avant** : pas de `Shot` des attaquants dans les **3 s** avant sa touche (`ownGoalShotWindowMs`),
  et la dernière touche d'un attaquant n'était pas sur la ligne (à plus de **10 m**, `ownGoalOnLineDistance`)

**Cible** : le joueur qui marque contre son camp. **Quand** : pendant le replay.
Fréquence mesurée : 3 sur 39 matchs enregistrés.

## 4. Lucarne 🎯
**Règle** — sur le `GoalScored` du replay (le 2e, pour un `ImpactLocation` fiable) :
- **Z ≥ 450** et **|X| ≥ 550** ⚙️
- Uniquement si aucune autre règle n'a commenté le but (on attend le replay pour avoir le bon point d'impact)

**Cible** : le buteur (compliment ironique ou vrai compliment). **Quand** : fin du replay.
⚠️ À valider sur plus de buts (le bon `ImpactLocation` est celui du replay).

## 5. Passe décisive par procuration 📎
**Idée** : la passe a été comptée mais n'y est pour rien.

**Règle** — sur `GoalScored` avec `Assister` :
- Dernière touche du passeur → but : **≥ 4 s** ⚙️
- **ou** le buteur a fait **≥ 3 touches** entre la passe et le but (il a tout fait seul)
- **ou** une touche adverse a eu lieu entre la passe et la touche du buteur

**Cible** : le passeur. **Quand** : pendant le replay.

## 6. MVP de justesse 👑
**Idée** : le MVP s'est joué à quelques points entre coéquipiers. On appuie sur le seum de celui qui l'a raté.

**Règle** — sur `StatfeedEvent` `MVP`, avec les scores finaux de `UpdateState` :
- Le MVP est toujours dans l'équipe gagnante : on le compare à son **meilleur coéquipier**
- Le MVP a **au plus 50 points** de plus que lui (`mvpMaxGap`) ⚙️

**Cible** : le coéquipier (c'est lui qui a le seum), en citant le MVP. **Quand** : à l'annonce du MVP.
Fréquence mesurée sur 33 matchs complets : 9 avec 50 points, 8 avec 30, 7 avec 20.

## 7. Le mendiant 🪙
**Retiré** : le boost d'un joueur ne disait pas assez s'il jouait mal.

## 8. Le fantôme 👻
**Idée** : un joueur qui ne touche plus la balle depuis trop longtemps.

**Règle** — en direct :
- **Aucune touche de balle** depuis **≥ 40 s en 3v3**, **≥ 30 s en 2v2** ⚙️ (pas de fantôme en 1v1). N'importe quelle touche remet le compteur à zéro.
- On ne compte que le temps de jeu effectif : le chrono s'arrête au but et repart de zéro à chaque coup d'envoi.

**Pourquoi ces seuils** : mesurés sur les matchs enregistrés (10 en 2v2, 8 en 3v3). À trois, on touche moins la balle :
le 95ᵉ centile des durées sans toucher est de 23 s en 2v2 contre 29 s en 3v3. Ces seuils donnent environ
**un fantôme par match et demi pour une équipe** (0,7 par match en 2v2, 0,8 en 3v3).

**Cible** : le joueur. **Quand** : en direct. **Pas d'anti-spam** : une fois par période sans toucher la balle (le compteur repart à la touche suivante), avec seulement l'écart de 15 s entre deux commentaires en direct.

## 9. Craquage 💥
**Retiré** : trop rare, et il reposait sur l'arrêt manqué.

## 10. Passe à l'adversaire 🎁
**Idée** : il donne la balle à l'adversaire, sans être sous pression, et ça part en contre.

**Règle** — touche du joueur P, touche suivante par un adversaire R :
- **Pas un duel** : R la récupère **≥ 1 s** après la touche de P (`giveawayMinMs`) ⚙️
- **R garde la balle** : la touche d'après est aussi celle de son équipe
- **Pas une excuse** :
  - la touche de P n'est pas un dégagement depuis son tiers défensif (touche à **≥ 25 m** de sa ligne, `giveawayMinOwnGoalDistance`)
  - ce n'est pas un tir ni un arrêt : pas de `Shot` / `Save` pour P dans les **2 s** (`giveawayShotWindowMs`, le jeu les annonce en retard)
  - ce n'est pas dans les **5 s** après l'engagement (`giveawayKickoffMs`)
- **Ça coûte** : l'équipe de R tire dans les **6 s** (`giveawayWindowMs`) ⚙️. Sans tir, rien n'est dit.

**Paliers** : tir adverse → « passe à l'adversaire » (dit dès que l'équipe de P récupère la balle, ou 4 s après le tir) ;
but adverse → « bénévole de l'année » (le commentaire du but). En fin de match, **bénévole du match** : le joueur qui a fait
le plus de passes à l'adversaire (tir ou but), au moins 3 (`giveawayOfTheMatchMin`).
**Cible** : P. Fréquence mesurée : environ 2 par match pour les deux équipes (64 sur 34 matchs).
**Limite** : sans position des voitures, on ne sait pas si c'était une passe vers un coéquipier mal placé.

---

## 11. Presque passe décisive à l'adversaire 🎁🧤
**Idée** : une passe dangereuse dans son propre camp (souvent en retrait), récupérée par un adversaire qui tire, et le tir est arrêté.

**Règle** — touche du joueur P, touche suivante par un adversaire :
- Touche **dans son propre camp** (à ≤ 51 m de sa ligne, `nearAssistMaxOwnGoalDistance`), y compris devant sa cage
- La balle **ne part pas vers l'avant** : au plus 5 m (`nearAssistMaxForward`) — ce n'est pas un dégagement
- **Pas un duel** : l'adversaire la récupère après ≥ 1 s (`nearAssistMinMs`)
- L'adversaire **tire dans les 4 s** (`nearAssistShotWindowMs`), puis **l'équipe de P arrête le tir** (arrêt ou arrêt miraculeux) dans les 2,5 s (`nearAssistSaveWindowMs`)

**Cible** : P, en citant le tireur et le sauveur. **Quand** : en direct, à l'arrêt. Remplace le « bénévole » simple sur la même balle.
Si l'adversaire marque à la place : « bénévole de l'année ».

---

## 12. Arrêt pour l'adversaire 🧱
**Idée** : un tir de l'équipe allait rentrer, et un coéquipier le sort juste devant la cage adverse.

**Règle** :
- Un joueur A fait un **tir cadré** (`Shot` du jeu)
- La **première touche** après le tir (≤ 2,5 s, `teamBlockMaxMs`) est celle d'un **coéquipier B** (pas A, pas un adversaire)
- B **sort la balle du cadre**. L'API ne donne pas la trajectoire de la balle, seulement sa position aux touches, donc on le déduit :
  - B touche la balle **devant la cage** : à ≤ 12 m de la ligne adverse (`teamBlockMaxDistance`), à ≤ 10 m du centre sur le côté
    (`teamBlockMaxSideOffset`, la cage fait ±8,9 m) et à ≤ 7,5 m de haut (`teamBlockMaxHeight`, la barre est à 6,4 m) ⚙️
  - sa touche n'est pas elle-même un tir cadré (pas de `Shot` pour B dans les 2 s, `teamBlockShotWindowMs`)
  - les adversaires n'ont **pas eu à l'arrêter** ensuite (pas de `Save` adverse) : la balle n'allait plus au but
- **Pas de but** dans les 3 s qui suivent (`teamBlockNoGoalMs`)

**Cible** : B, en citant A. **Quand** : en direct, 3 s après la touche.
Rare : 2 sur 39 matchs enregistrés (4 avant d'exiger que la balle sorte du cadre).

---

## 13. Quasi-but : barre, poteau, équerre 🔔
**Idée** : un tir tape le cadre et ne rentre pas. On se moque du tireur.

**Règle** — événement `CrossbarHit` du jeu (il couvre la barre, les poteaux et les équerres) :
- Pendant le jeu (pas le renvoi du même événement pendant un replay), un seul par impact
- La dernière touche avant l'impact est celle du tireur, il y a **≤ 2,5 s** (`nearGoalShotMaxMs`), et la balle va à **≥ 30 km/h** (`nearGoalMinSpeed`) : pas une balle morte qui roule sur le poteau
- **Pas de but** dans les 2 s (`nearGoalNoGoalMs`) : les poteaux rentrants ne comptent pas
- Zone : **barre** si l'impact est à ≥ 5,5 m de haut (`nearGoalCrossbarMinHeight`), **poteau** sinon ; **équerre** si en plus il est à ≥ 7,5 m du centre (`nearGoalPostMinSideOffset`)

**Cible** : le tireur. **Quand** : en direct, 2 s après l'impact. Compte dans le bilan (« Ferrailleur de la soirée »).
Fréquence mesurée : 12 sur les 14 premiers matchs enregistrés.

---

## Activer ou désactiver une règle

Dans `config.json` → `rules`, chaque règle vaut `true` (active) ou `false` (coupée), même pendant que le bot tourne.
On peut couper une famille entière (`"giveaway": false`) ou une seule variante (`"giveaway.ofTheMatch": false`, `"nearGoal.post": false`).
Une règle coupée n'est plus détectée du tout : pas de voix, pas de message à voter, rien dans le bilan, et ses phrases sortent de la bibliothèque de voix.

| Clé | Règle |
|---|---|
| `tapIn` | Tap-in |
| `steal` | Vol de but |
| `ownGoal` | Contre son camp |
| `finish` | Lucarne |
| `adminAssist` | Passe décisive par procuration |
| `mvp` | MVP de justesse |
| `ghost` | Fantôme |
| `giveaway` | Passe à l'adversaire, presque passe décisive à l'adversaire, bénévole de l'année, bénévole du match |
| `teamBlock` | Arrêt pour l'adversaire |
| `nearGoal` | Barre, poteau, équerre |

## Qui est commenté

Par défaut (`target: "our-team"` dans config.json), seul **notre équipe** se fait chambrer : l'équipe où joue au moins un joueur de la bande (`players`). Les comptes d'un même joueur comptent comme un seul.
Le joueur visé (buteur du tap-in, voleur, auteur du contre son camp, passeur, coéquipier du MVP de justesse, fantôme, bénévole) doit en faire partie.
Les adversaires peuvent être cités (ex. celui qui marque après un cadeau), mais ne sont jamais la cible : la voix dit « l'adversaire » ou un synonyme.
Le bilan de la soirée ne parle que de la bande.

**Détection pour tout le monde, voix pour notre équipe** : le bot détecte les situations des deux équipes. Seules celles de notre équipe sont dites ;
les autres sont postées « non dit » pour voter. Les votes ne sont demandés que sur ce qui se voit (buts, arrêts, ballons rendus, MVP…) :
le fantôme seulement pour un joueur de la bande, qui est seul à pouvoir en juger.

## Priorités (1 seul commentaire par but)

Si plusieurs règles se déclenchent sur le même but, on garde la plus piquante parmi celles qui visent un joueur de notre équipe :
**Vol de but > Bénévole de l'année > Contre son camp > Tap-in > Passe décisive par procuration > Lucarne**
(la lucarne est décidée pendant le replay, avec le point d'impact dans la cage : elle passe après les autres)

Les règles en direct (fantôme, bénévole, quasi-buts) ne parlent jamais pendant un replay, et laissent
**≥ 15 s** entre deux commentaires.

## Non retenu
- Double commit (on ne voit pas les touches ratées)
- Rotation / dernier défenseur (pas de position des voitures)
