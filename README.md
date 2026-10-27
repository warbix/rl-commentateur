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
4. Activer l'API Stats de Rocket League : dans le dossier d'installation du jeu, ouvrir
   `TAGame\Config\DefaultStatsAPI.ini` et passer `PacketSendRate=0` à `PacketSendRate=30`, puis relancer le jeu.
   - Steam : `...\steamapps\common\rocketleague\`
   - Epic : `C:\Program Files\Epic Games\rocketleague\` (par défaut)
5. Copier `config.exemple.json` en `config.json` (ce fichier contiendra le token : il est ignoré par git).

### 1. Créer le bot Discord (5 minutes)

1. Va sur <https://discord.com/developers/applications> et clique **New Application**. Donne-lui un nom (ex. « Le Commentateur »).
2. Menu **Bot** → **Reset Token** → copie le token. ⚠️ C'est le mot de passe du bot : ne le partage jamais.
3. Menu **OAuth2** → **URL Generator** :
   - Scopes : coche **bot**
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

### Tester sans jouer

Rejoue un vrai match classé 3v3 enregistré, avec le son sur les haut-parleurs du PC.
Les pseudos y sont anonymisés (`MonPseudo`, `Coequipier1`…), d'où la config d'exemple qui les connaît :
```
npm start -- --local --rejouer capture.jsonl --vitesse 5 --config config.exemple.json
```
- `--local` : son sur le PC au lieu de Discord · `--muet` : texte seulement
- `--rejouer fichier.jsonl` : rejoue une partie enregistrée · `--vitesse 5` : 5 fois plus vite
- `--config fichier.json` : utilise une autre config que `config.json`

### Enregistrer un nouveau match (pour régler les seuils)

```
node capture.js mon-match.jsonl
```
Laisse tourner pendant la partie, puis rejoue-le avec `--rejouer mon-match.jsonl`.

---

## Personnaliser

| Quoi | Où | Pris en compte |
|---|---|---|
| Les phrases | `phrases.json` | Tout de suite, même pendant une partie |
| Qui est commenté (`commenter` : `notre-equipe` ou `tout-le-monde`) | `config.json` | Tout de suite |
| Surnoms (`surnoms`) et prononciation (`prononciation`, ex. « aime vie pie ») | `config.json` | Tout de suite |
| Voix et rotation (`voix`) | `config.json` | Tout de suite (sauf le volume) |
| Seuils de détection (distances, durées…) | `src/detector.js`, en haut du fichier | Au prochain lancement |
| Token, salon, volume | `config.json` | Au prochain lancement |

Les phrases déjà générées sont gardées dans `cache/` : elles ne repassent pas par internet et sont lues sans attente.
Tu peux vider ce dossier sans risque.

---

## En cas de souci

| Problème | Solution |
|---|---|
| « En attente de Rocket League » en pleine partie | Une mise à jour du jeu a peut-être remis `PacketSendRate=0` dans `DefaultStatsAPI.ini`. Remets `30` et relance le jeu. |
| « Salon vocal introuvable » | Vérifie `salonVocalId` et que le bot est bien sur le serveur (étape 1.4). |
| Erreur de login Discord | Le token est faux ou a été régénéré : refais **Reset Token** et recolle-le. |
| « edge-tts a échoué » | Problème de connexion au service de voix de Microsoft (gratuit, non officiel). Les phrases déjà en cache marchent quand même. |
| Le bot parle trop / pas assez | Ajuste les seuils en haut de `src/detector.js`, ou retire des phrases. |

## Plusieurs joueurs avec le bot

Chacun peut installer le bot sur son PC (voir Installation). Mais si deux personnes du même match lancent le bot dans le même salon, vous aurez les commentaires en double : un seul suffit.
