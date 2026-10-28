// Bot Discord : rejoint le salon vocal, lit les fichiers audio à la suite,
// et répond aux commandes /… déclarées avec addCommand().

const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, Partials } = require("discord.js");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
} = require("@discordjs/voice");

class DiscordVoice {
  constructor({ token, salonVocalId, salonTexteId, suivre = [] }, { volume = 1 } = {}) {
    this.token = token;
    this.voiceChannelId = salonVocalId;
    // Membres à suivre, par ordre de priorité : identifiant Discord, nom d'utilisateur, nom affiché ou pseudo du serveur
    this.follow = (Array.isArray(suivre) ? suivre : [suivre]).filter(Boolean).map((x) => String(x).toLowerCase());
    this.textChannelId = salonTexteId;
    this.volume = volume;
    this.queue = [];
    this.commands = new Map();
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.player.on("error", (e) => { console.error("Erreur de lecture :", e.message); this.playNext(); });
  }

  async start() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions],
      // Pour recevoir les votes sur des messages postés avant une relance du bot
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    const ready = new Promise((resolve) => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.token);
    await ready;
    console.log(`Discord : connecté en tant que ${this.client.user.tag}`);

    const home = await this.client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!home || !home.isVoiceBased()) throw new Error(`Salon vocal introuvable (salonVocalId = ${this.voiceChannelId}). Le bot est bien invité sur le serveur ?`);
    this.me = await home.guild.members.fetchMe();
    if (this.textChannelId) await this.setupTextChannel();

    // En priorité le salon où se trouve un membre suivi, sinon le salon de config.json
    const followed = this.followedChannel(home.guild);
    let channel = home;
    if (followed && !this.missingPerms(followed).length) channel = followed;
    else if (followed) console.log(`Discord : pas les droits sur « ${followed.name} » (salon suivi), on va dans « ${home.name} »`);

    const missing = this.missingPerms(channel);
    if (missing.length) {
      throw new Error(`le bot n'a pas les droits ${missing.join(", ")} sur le salon « ${channel.name} ». ` +
        "Discord → clic droit sur le salon → Modifier le salon → Permissions → ajoute le rôle du bot et autorise ces droits.");
    }

    this.connect(channel);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`Discord : dans le salon vocal « ${channel.name} »${channel === followed ? " (salon suivi)" : ""}`);

    // Si un membre suivi change de salon vocal, le bot le suit
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (!after.channel || !this.isFollowed(after.member)) return;
      // Le membre suivi le plus prioritaire qui est en vocal décide du salon
      const target = this.followedChannel(after.guild);
      if (!target || target.id === this.channel.id) return;
      if (this.missingPerms(target).length) return console.log(`Discord : pas les droits pour suivre dans « ${target.name} »`);
      this.moveTo(target);
    });

    await this.registerCommands(channel.guild);
  }

  // Salon texte des déclenchements : on y poste et on écoute les votes (réactions)
  async setupTextChannel() {
    const channel = await this.client.channels.fetch(this.textChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return console.log(`Discord : salon texte introuvable (salonTexteId = ${this.textChannelId}), pas de votes`);
    const perms = channel.permissionsFor(this.me);
    const missing = [["ViewChannel", "Voir le salon"], ["SendMessages", "Envoyer des messages"], ["AddReactions", "Ajouter des réactions"], ["ReadMessageHistory", "Voir les anciens messages"]]
      .filter(([flag]) => !perms || !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
    if (missing.length) return console.log(`Discord : il manque les droits ${missing.join(", ")} sur « ${channel.name} », pas de votes`);
    this.textChannel = channel;
    console.log(`Discord : déclenchements et votes dans « #${channel.name} »`);

    const onReaction = (added) => async (reaction, user) => {
      if (user.bot || reaction.message.channelId !== channel.id || !this.onVote) return;
      this.onVote(reaction.message.id, reaction.emoji.name, user.id, added);
    };
    this.client.on(Events.MessageReactionAdd, onReaction(true));
    this.client.on(Events.MessageReactionRemove, onReaction(false));
  }

  // Poste un message dans le salon texte avec ses boutons de vote ; renvoie l'identifiant du message
  async post(content, reactions = []) {
    if (!this.textChannel) return null;
    try {
      const message = await this.textChannel.send({ content, allowedMentions: { parse: [] } });
      for (const r of reactions) await message.react(r);
      return message.id;
    } catch (e) {
      console.error("Discord : message non posté :", e.message);
      return null;
    }
  }

  // Sans ces droits, la connexion vocale reste bloquée sans message clair
  missingPerms(channel) {
    const perms = channel.permissionsFor(this.me);
    return [["ViewChannel", "Voir le salon"], ["Connect", "Se connecter"], ["Speak", "Parler"]]
      .filter(([flag]) => !perms || !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
  }

  // Rang du membre dans la liste "suivre" (-1 s'il n'y est pas)
  followRank(member) {
    if (!member || member.user.bot) return -1;
    const names = [member.id, member.user.username, member.user.globalName, member.displayName, member.nickname]
      .filter(Boolean).map((x) => x.toLowerCase());
    return this.follow.findIndex((f) => names.includes(f));
  }

  isFollowed(member) {
    return this.followRank(member) >= 0;
  }

  // Salon vocal du membre suivi le plus prioritaire actuellement en vocal
  followedChannel(guild) {
    let best = null;
    for (const state of guild.voiceStates.cache.values()) {
      const rank = this.followRank(state.member);
      if (rank >= 0 && state.channel && (!best || rank < best.rank)) best = { rank, channel: state.channel };
    }
    return best && best.channel;
  }

  moveTo(channel) {
    this.channel = channel;
    this.connection.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
    console.log(`Discord : suit dans le salon vocal « ${channel.name} »`);
  }

  // builder : un SlashCommandBuilder ; handler(interaction) renvoie le texte de la réponse
  addCommand(builder, handler) {
    this.commands.set(builder.name, { builder, handler });
  }

  async registerCommands(guild) {
    if (!this.commands.size) return;
    try {
      // Commandes du serveur (et pas globales) : disponibles immédiatement
      await guild.commands.set([...this.commands.values()].map((c) => c.builder.toJSON()));
      console.log(`Discord : commandes ${[...this.commands.keys()].map((n) => "/" + n).join(" ")} disponibles`);
    } catch (e) {
      console.log(`Discord : impossible d'ajouter les commandes (${e.message}). Réinvite le bot avec le scope applications.commands (voir README).`);
    }
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const command = this.commands.get(interaction.commandName);
      if (!command) return;
      try {
        const reply = await command.handler(interaction);
        if (reply) await interaction.reply(reply);
      } catch (e) {
        console.error(`Commande /${interaction.commandName} :`, e.message);
        if (!interaction.replied) interaction.reply({ content: "Oups, ça a planté.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    });
  }

  connect(channel) {
    this.channel = channel;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection.subscribe(this.player);
    // Si on est déconnecté (changement de région, coupure…), on tente de revenir avant d'abandonner
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.connection.destroy();
        console.log("Discord : déconnecté du vocal, nouvelle tentative dans 5 s");
        setTimeout(() => this.connect(this.channel), 5000);
      }
    });
  }

  enqueue(file) {
    this.queue.push(file);
    if (this.player.state.status === AudioPlayerStatus.Idle) this.playNext();
  }

  playNext() {
    const file = this.queue.shift();
    if (!file) return;
    const resource = createAudioResource(file, { inlineVolume: true });
    resource.volume.setVolume(this.volume);
    this.player.play(resource);
  }
}

module.exports = { DiscordVoice };
