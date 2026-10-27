// Bot Discord : rejoint le salon vocal et lit les fichiers audio à la suite.

const { Client, GatewayIntentBits, Events } = require("discord.js");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
} = require("@discordjs/voice");

class DiscordVoice {
  constructor({ token, salonVocalId, salonTexteId }, { volume = 1 } = {}) {
    this.token = token;
    this.voiceChannelId = salonVocalId;
    this.textChannelId = salonTexteId;
    this.volume = volume;
    this.queue = [];
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.player.on("error", (e) => { console.error("Erreur de lecture :", e.message); this.playNext(); });
  }

  async start() {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const ready = new Promise((resolve) => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.token);
    await ready;
    console.log(`Discord : connecté en tant que ${this.client.user.tag}`);

    const channel = await this.client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) throw new Error(`Salon vocal introuvable (salonVocalId = ${this.voiceChannelId}). Le bot est bien invité sur le serveur ?`);
    if (this.textChannelId) this.textChannel = await this.client.channels.fetch(this.textChannelId).catch(() => null);

    this.connect(channel);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`Discord : dans le salon vocal « ${channel.name} »`);
  }

  connect(channel) {
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
        setTimeout(() => this.connect(channel), 5000);
      }
    });
  }

  enqueue(file, text) {
    this.queue.push(file);
    if (this.textChannel && text) this.textChannel.send(text).catch(() => {});
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
