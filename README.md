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
4. Activer l'API Stats de Rocket League : `npm run verifier-api`, puis relancer le jeu s'il était ouvert.
   Le bot trouve tout seul les installations **Steam** (toutes les bibliothèques) et **Epic**, et passe
   `PacketSendRate` à `30` dans `TAGame\Config\DefaultStatsAPI.ini` (une copie `.bak` de l'original est gardée).
   Il refait cette vérification à chaque lancement puis toutes les 10 minutes : si une mise à jour du jeu
   remet la valeur à 0, elle est corrigée automatiquement. Installation ailleurs ? Ajoute son dossier dans
   `config.json` → `rocketLeague.cheminsJeu`.
5. Copier `config.exemple.json` en `config.json` (ce fichier contiendra le token : il est ignoré par git).

### 1. Créer le bot Discord (5 minutes)

1. Va sur <https://discord.com/developers/applications> et clique **New Application**. Donne-lui un nom (ex. « Le Commentateur »).
2. Menu **Bot** → **Reset Token** → copie le token. ⚠️ C'est le mot de passe du bot : ne le partage jamais.
3. Menu **OAuth2** → **URL Generator** :
   - Scopes : coche **bot** et **applications.commands** (pour les commandes /chut, /parle…)
   - Bot Permissions : coche **View Channels**, **Connect**, **Speak** (et **Send Messages** si tu veux aussi les phrases écrites)
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
    "salonVocalId": "l'identifiant copié à l'étape 2",
    "salonTexteId": ""
  },
  "surnoms": { "TonPseudoEnJeu": ["Ton surnom", "Un autre surnom"], ... },
  "voix": { "rotation": "aleatoire", "liste": ["fr-FR-HenriNeural", ...], ... },
  ...
}
```

### 4. Choisir les voix

Le bot change de voix à chaque phrase parmi `voix.liste` dans `config.json`. `voix.rotation` vaut :
- `aleatoire` : au hasard, jamais deux fois de suite la même (par défaut)
- `alternee` : chacune son tour
- `fixe` : toujours la première de la liste

Écoute les extraits du dossier `echantillons/` et garde dans `voix.liste` celles qui te plaisent :

| Fichier | Nom à mettre dans `voix.liste` |
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

**Double-clic sur `lancer.bat`** (ou `npm start` dans un terminal ouvert dans ce dossier).
Le bot rejoint le salon vocal, puis attend Rocket League. L'ordre de lancement n'a pas d'importance.
Ferme la fenêtre pour l'arrêter.

### Commandes Discord

Dans n'importe quel salon du serveur :

| Commande | Effet |
|---|---|
| `/chut` | Coupe les commentaires (le bot reste dans le vocal) |
| `/parle` | Les relance |
| `/volume 80` | Règle le volume du commentateur (0 à 200 %) |
| `/bilan` | Bilan de la soirée en vocal et par écrit : victoires, roi du tap-in, passoire d'or, bénévole, fantôme… |

Le bilan compte tout depuis le lancement du bot, même ce qui n'a pas été commenté. Il s'affiche aussi dans la console quand on arrête le bot (Ctrl+C).

Si les commandes n'apparaissent pas, le bot a été invité sans le scope `applications.commands` : régénère l'URL d'invitation (étape 1.3) et réinvite-le, sans le retirer du serveur.

### Tester sans jouer

Rejoue un vrai match classé 3v3 enregistré, avec le son sur les haut-parleurs du PC.
Les pseudos y sont anonymisés (`MonPseudo`, `Coequipier1`…), d'où la config d'exemple qui les connaît :
```
npm start -- --local --rejouer capture.jsonl --vitesse 5 --config config.exemple.json
```
- `--local` : son sur le PC au lieu de Discord · `--muet` : texte seulement
- `--rejouer fichier.jsonl` : rejoue une partie enregistrée · `--vitesse 5` : 5 fois plus vite
- `--config fichier.json` : utilise une autre config que `config.json`

### Matchs enregistrés (pour régler les seuils)

Chaque match joué avec le bot est enregistré dans `matchs/` (un fichier par partie, avec les commentaires du bot dedans).
Si le bot s'est trompé, rejoue la partie après avoir changé un seuil :
```
npm start -- --muet --rejouer matchs/2026-10-27_21-04-12_611EB566.jsonl --vitesse 1000
```
Pour désactiver : `"enregistrerMatchs": false` dans `config.json`. `node capture.js fichier.jsonl` enregistre aussi sans lancer le bot.

---

## Personnaliser

| Quoi | Où | Pris en compte |
|---|---|---|
| Les phrases | `phrases.json` | Tout de suite, même pendant une partie |
| Qui est commenté (`commenter` : `notre-equipe` ou `tout-le-monde`) | `config.json` | Tout de suite |
| Surnoms (`surnoms`) et prononciation (`prononciation`, ex. « aime vie pie ») | `config.json` | Tout de suite |
| Voix et rotation (`voix`) | `config.json` | Tout de suite (sauf le volume) |
| Seuils de détection (distances, durées…) | `src/detector.js`, en haut du fichier | Au prochain lancement |
| Token, salon, volume, vérification de l'API (`rocketLeague`) | `config.json` | Au prochain lancement |

Les phrases déjà générées sont gardées dans `cache/` : elles ne repassent pas par internet et sont lues sans attente.
Au lancement, le bot prépare aussi en arrière-plan les phrases qui ne citent que la bande (tap-in, vol, lucarne, MVP) pour toutes les
combinaisons de pseudos de `surnoms` : elles sortent instantanément. La réserve se refait toute seule si tu changes les phrases,
les surnoms ou les voix (`"pregenerer": false` pour désactiver).
Tu peux vider ce dossier sans risque.

---

## En cas de souci

| Problème | Solution |
|---|---|
| « En attente de Rocket League » en pleine partie | Le jeu a été lancé avant que le bot corrige `PacketSendRate` (message « relance le jeu » dans la console) : relance le jeu. Si le bot dit « accès refusé », lance `lancer.bat` une fois en administrateur. |
| « Salon vocal introuvable » | Vérifie `salonVocalId` et que le bot est bien sur le serveur (étape 1.4). |
| Erreur de login Discord | Le token est faux ou a été régénéré : refais **Reset Token** et recolle-le. |
| « edge-tts a échoué » | Problème de connexion au service de voix de Microsoft (gratuit, non officiel). Les phrases déjà en cache marchent quand même. |
| Le bot parle trop / pas assez | Ajuste les seuils en haut de `src/detector.js`, ou retire des phrases. |

## Plusieurs joueurs avec le bot

Chacun peut installer le bot sur son PC (voir Installation). Mais si deux personnes du même match lancent le bot dans le même salon, vous aurez les commentaires en double : un seul suffit.
