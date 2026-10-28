# Commentateur Rocket League pour Discord

Le programme écoute Rocket League pendant que tu joues, repère les situations de [REGLES.md](REGLES.md)
(tap-in, vol de but, arrêt manqué, bénévole…), tire une phrase au hasard dans [phrases.json](phrases.json)
et la fait lire par une voix française dans votre salon vocal Discord.

Tout tourne **sur ton PC** : pas de serveur à louer.

---

## Installation (une seule fois)

### 0. Prérequis

1. Installer **Node.js** (version LTS) et **Python 3** (cocher « Add to PATH »).
2. Dans un terminal : `pip install edge-tts`
3. Dans un terminal ouvert dans ce dossier : `npm install`
4. Activer l'API Stats de Rocket League : `npm run check-api`, puis relancer le jeu s'il était ouvert.
   Le bot trouve tout seul les installations **Steam** (toutes les bibliothèques) et **Epic**, et passe
   `PacketSendRate` à `30` dans `TAGame\Config\DefaultStatsAPI.ini` (une copie `.bak` de l'original est gardée).
   Il refait cette vérification à chaque lancement puis toutes les 10 minutes : si une mise à jour du jeu
   remet la valeur à 0, elle est corrigée automatiquement. Installation ailleurs ? Ajoute son dossier dans
   `config.json` → `rocketLeague.gamePaths`.
5. Copier `config.example.json` en `config.json` (ce fichier contiendra le token : il est ignoré par git).

### 1. Créer le bot Discord (5 minutes)

1. Va sur <https://discord.com/developers/applications> et clique **New Application**. Donne-lui un nom (ex. « Le Commentateur »).
2. Menu **Bot** → **Reset Token** → copie le token. ⚠️ C'est le mot de passe du bot : ne le partage jamais.
3. Menu **OAuth2** → **URL Generator** :
   - Scopes : coche **bot** et **applications.commands** (pour les commandes /mute, /unmute…)
   - Bot Permissions : coche **View Channels**, **Connect**, **Speak**, et pour les votes **Send Messages**, **Add Reactions**, **Read Message History**
4. Copie l'URL générée en bas, ouvre-la dans ton navigateur et ajoute le bot sur votre serveur.

### 2. Récupérer l'identifiant du salon vocal

1. Discord → Paramètres utilisateur → **Avancés** → active le **Mode développeur**.
2. Clic droit sur votre salon vocal → **Copier l'identifiant du salon**.
3. (Optionnel) Pareil sur un salon texte si tu veux que le bot y écrive aussi ses phrases.

### 3. Remplir `config.json`

```json
{
  "discord": {
    "token": "le token copié à l'étape 1",
    "voiceChannelId": "l'identifiant copié à l'étape 2",
    "textChannelId": ""
  },
  "nicknames": { "TonPseudoEnJeu": ["Ton surnom", "Un autre surnom"], ... },
  "voice": { "rotation": "random", "list": ["fr-FR-HenriNeural", ...], ... },
  ...
}
```

### 3 bis. Suivre quelqu'un (optionnel)

Dans `config.json` → `discord.follow`, mets les membres Discord à suivre, par priorité (identifiant, nom d'utilisateur ou nom affiché), ex. `["MonPseudoDiscord", "UnPote"]`.
Au lancement, le bot rejoint le salon vocal du premier d'entre eux qui est en vocal, et le suit s'il change de salon.
Si aucun n'est en vocal, il va dans `voiceChannelId`. Il lui faut les droits Voir le salon, Se connecter et Parler sur chaque salon.

### 4. Choisir les voix

Le bot change de voix à chaque phrase parmi `voice.list` dans `config.json`. `voice.rotation` vaut :
- `random` : au hasard, jamais deux fois de suite la même (par défaut)
- `alternate` : chacune son tour
- `fixed` : toujours la première de la liste

Écoute les extraits du dossier `samples/` et garde dans `voice.list` celles qui te plaisent :

| Fichier | Nom à mettre dans `voice.list` |
|---|---|
| 1-Henri-France | `fr-FR-HenriNeural` |
| 2-Remy-France | `fr-FR-RemyMultilingualNeural` |
| 3-Denise-France | `fr-FR-DeniseNeural` |
| 4-Vivienne-France | `fr-FR-VivienneMultilingualNeural` |
| 5-Antoine-Quebec | `fr-CA-AntoineNeural` |
| 6-Gerard-Belgique | `fr-BE-GerardNeural` |

Autres voix possibles : `fr-FR-EloiseNeural`, `fr-CA-JeanNeural`, `fr-CA-ThierryNeural`, `fr-CA-SylvieNeural`, `fr-CH-FabriceNeural`, `fr-CH-ArianeNeural`, `fr-BE-CharlineNeural`.
`vitesse` (ex. `+15%`) et `hauteur` (ex. `-5Hz`) permettent de la rendre plus nerveuse ou plus grave.

---

## Utilisation

**Double-clic sur `start.bat`** (ou `npm start` dans un terminal ouvert dans ce dossier).
Le bot rejoint le salon vocal, puis attend Rocket League. L'ordre de lancement n'a pas d'importance.
Ferme la fenêtre pour l'arrêter.

### Commandes Discord

Dans n'importe quel salon du serveur :

| Commande | Effet |
|---|---|
| `/mute` | Coupe les commentaires (le bot reste dans le vocal) |
| `/unmute` | Les relance |
| `/volume 80` | Règle le volume du commentateur (0 à 200 %) |
| `/recap` | Bilan de la soirée en vocal et par écrit : victoires, roi du tap-in, passoire d'or, bénévole, fantôme… |

Le bilan compte tout ce qui s'est passé dans la soirée, même ce qui n'a pas été commenté, et survit aux relances du bot (il repart à zéro après 6 h sans match). Il s'affiche aussi dans la console quand on arrête le bot (Ctrl+C).

Si les commandes n'apparaissent pas, le bot a été invité sans le scope `applications.commands` : régénère l'URL d'invitation (étape 1.3) et réinvite-le, sans le retirer du serveur.

### Voter sur les déclenchements (pour régler le bot)

Mets l'identifiant d'un salon texte dans `config.json` → `discord.textChannelId` (le bot doit pouvoir y voir le salon,
envoyer des messages, ajouter des réactions et voir les anciens messages). Pendant le match, chaque déclenchement y est
posté **tout de suite**, numéroté, avec le chrono du match et les mesures qui l'ont déclenché :

> **#12** · ⏱ 2:34 · match de 21:04 · **Tap-in** → MonPseudo
> dernière touche à la ligne 6,2 m (max 9,0 m) ✓ · vitesse après la touche 31 km/h (max 50 km/h) ✓ · …
> > *la phrase dite*

- ✅ / ❌ : le commentaire était-il mérité ? Vous pouvez voter pendant le replay du but.
- **Presque** : quand une situation rate ses seuils de peu, le bot ne dit rien mais poste un `#13 ?`. 👍 = il fallait le dire, 👎 = non.
- `/feedback 12 trop sévère` : pour nuancer (« c'était un vol, pas un tap-in », « il fallait le dire »…).
- Avec le chrono, vous pouvez retrouver l'action dans le replay Rocket League.

Tout est gardé dans `feedback/` (ignoré par git). `npm run calibrate` lit les votes et propose des seuils (voir plus bas).

### Régler les seuils d'après vos votes

```
npm run calibrate
```
Pour chaque règle : les votes (✅/❌, 👍/👎 sur les « presque »), chaque mesure avec les valeurs validées (✓) et rejetées (✗),
le seuil qui respecterait le plus de votes, et vos `/feedback`. Rien ne bouge tant qu'une mesure a moins de 4 votes.
Une règle a plusieurs mesures, donc un ❌ peut venir d'une autre mesure : relis avant d'appliquer.
`npm run calibrate -- --apply` écrit les seuils proposés dans `config.json` → `thresholds` (pris en compte tout de suite).

### Tester sans jouer

Rejoue un vrai match classé 3v3 enregistré, avec le son sur les haut-parleurs du PC.
Les pseudos y sont anonymisés (`MonPseudo`, `Coequipier1`…), d'où la config d'exemple qui les connaît :
```
npm start -- --local --replay capture.jsonl --speed 5 --config config.example.json
```
- `--local` : son sur le PC au lieu de Discord · `--text-only` : texte seulement
- `--replay fichier.jsonl` : rejoue une partie enregistrée · `--speed 5` : 5 fois plus vite
- `--config fichier.json` : utilise une autre config que `config.json`

### Matchs enregistrés (pour régler les seuils)

Chaque match joué avec le bot est enregistré dans `matches/` (un fichier par partie, avec les commentaires du bot dedans).
Si le bot s'est trompé, rejoue la partie après avoir changé un seuil :
```
npm start -- --text-only --replay matches/2026-10-27_21-04-12_611EB566.jsonl --speed 1000
```
Pour désactiver : `"recordMatches": false` dans `config.json`. `node capture.js fichier.jsonl` enregistre aussi sans lancer le bot.

---

## Personnaliser

| Quoi | Où | Pris en compte |
|---|---|---|
| Les phrases | `phrases.json` | Tout de suite, même pendant une partie |
| Qui est commenté (`target` : `our-team` ou `everyone`) | `config.json` | Tout de suite |
| Surnoms (`nicknames`) et prononciation (`pronunciation`, ex. « aime vie pie ») | `config.json` | Tout de suite |
| Voix et rotation (`voice`) | `config.json` | Tout de suite (sauf le volume) |
| Bruitage avant chaque phrase (`voice.jingle` : `true` pour le ding, `false`, ou le chemin d'un son à toi) | `config.json` | Tout de suite |
| Seuils de détection (distances, durées…) | `config.json` → `thresholds` | Tout de suite |
| Token, salon, volume, vérification de l'API (`rocketLeague`) | `config.json` | Au prochain lancement |

Les phrases déjà générées sont gardées dans `cache/` : elles ne repassent pas par internet et sont lues sans attente.
Au lancement, le bot prépare aussi en arrière-plan les phrases qui ne citent que la bande (tap-in, vol, lucarne, MVP) pour toutes les
combinaisons de pseudos de `nicknames` : elles sortent instantanément. La réserve se refait toute seule si tu changes les phrases,
les surnoms ou les voix (`"pregenerate": false` pour désactiver).
Tu peux vider ce dossier sans risque.

---

## Tests

```
npm test
```
Rejoue le match enregistré et vérifie que le bot dit toujours la même chose, que les phrases sont valides et que la
réactivation de l'API marche. À lancer après avoir touché aux seuils ou aux phrases : si un test casse sans que ce soit
voulu, c'est qu'une règle a changé de comportement.

---

## En cas de souci

| Problème | Solution |
|---|---|
| « En attente de Rocket League » en pleine partie | Le jeu a été lancé avant que le bot corrige `PacketSendRate` (message « relance le jeu » dans la console) : relance le jeu. Si le bot dit « accès refusé », lance `start.bat` une fois en administrateur. |
| « Salon vocal introuvable » | Vérifie `voiceChannelId` et que le bot est bien sur le serveur (étape 1.4). |
| Erreur de login Discord | Le token est faux ou a été régénéré : refais **Reset Token** et recolle-le. |
| « edge-tts a échoué » | Problème de connexion au service de voix de Microsoft (gratuit, non officiel). Les phrases déjà en cache marchent quand même. |
| Le bot parle trop / pas assez | Ajuste les seuils dans `config.json` → `thresholds` (ou `npm run calibrate`), ou retire des phrases. |

## Plusieurs joueurs avec le bot

Chacun peut installer le bot sur son PC (voir Installation). Mais si deux personnes du même match lancent le bot dans le même salon, vous aurez les commentaires en double : un seul suffit.
