// Discord bot: joins the voice channel, plays the audio files one after the other,
// posts the triggers in the text channel, and answers the /… commands declared with addCommand().

const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, Partials } = require("discord.js");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
} = require("@discordjs/voice");

class DiscordVoice {
  constructor({ token, voiceChannelId, textChannelId, follow = [] }, { volume = 1 } = {}) {
    this.token = token;
    this.voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId;
    // Members to follow, by priority: Discord id, username, display name or server nickname
    this.follow = (Array.isArray(follow) ? follow : [follow]).filter(Boolean).map((x) => String(x).toLowerCase());
    this.volume = volume;
    this.queue = [];
    this.commands = new Map();
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.player.on("error", (e) => { console.error("Playback error:", e.message); this.playNext(); });
  }

  async start() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions],
      // To receive votes on messages posted before a bot restart
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    const ready = new Promise((resolve) => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.token);
    await ready;
    console.log(`Discord: logged in as ${this.client.user.tag}`);

    const home = await this.client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!home || !home.isVoiceBased()) throw new Error(`Voice channel not found (voiceChannelId = ${this.voiceChannelId}). Is the bot invited on the server?`);
    this.me = await home.guild.members.fetchMe();
    if (this.textChannelId) await this.setupTextChannel();

    // First the channel of a followed member, otherwise the channel from config.json
    const followed = this.followedChannel(home.guild);
    let channel = home;
    if (followed && !this.missingPerms(followed).length) channel = followed;
    else if (followed) console.log(`Discord: no permission on "${followed.name}" (followed channel), going to "${home.name}"`);

    const missing = this.missingPerms(channel);
    if (missing.length) {
      throw new Error(`the bot is missing the ${missing.join(", ")} permission(s) on "${channel.name}". ` +
        "Discord → right-click the channel → Edit Channel → Permissions → add the bot's role and allow them.");
    }

    this.connect(channel);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`Discord: in voice channel "${channel.name}"${channel === followed ? " (followed)" : ""}`);

    // If a followed member changes voice channel, the bot follows
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (!after.channel || !this.isFollowed(after.member)) return;
      // The highest-priority followed member in voice decides the channel
      const target = this.followedChannel(after.guild);
      if (!target || target.id === this.channel.id) return;
      if (this.missingPerms(target).length) return console.log(`Discord: no permission to follow into "${target.name}"`);
      this.moveTo(target);
    });

    await this.registerCommands(channel.guild);
  }

  // Text channel of the triggers: the bot posts there and listens to the votes (reactions)
  async setupTextChannel() {
    const channel = await this.client.channels.fetch(this.textChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return console.log(`Discord: text channel not found (textChannelId = ${this.textChannelId}), no votes`);
    const perms = channel.permissionsFor(this.me);
    const missing = ["ViewChannel", "SendMessages", "AddReactions", "ReadMessageHistory"]
      .filter((flag) => !perms || !perms.has(PermissionFlagsBits[flag]));
    if (missing.length) return console.log(`Discord: missing ${missing.join(", ")} on "${channel.name}", no votes`);
    this.textChannel = channel;
    console.log(`Discord: triggers and votes in "#${channel.name}"`);

    const onReaction = (added) => async (reaction, user) => {
      if (user.bot || reaction.message.channelId !== channel.id || !this.onVote) return;
      this.onVote(reaction.message.id, reaction.emoji.name, user.id, added);
    };
    this.client.on(Events.MessageReactionAdd, onReaction(true));
    this.client.on(Events.MessageReactionRemove, onReaction(false));
  }

  // Posts a message in the text channel with its vote buttons; returns the message id
  async post(content, reactions = []) {
    if (!this.textChannel) return null;
    try {
      const message = await this.textChannel.send({ content, allowedMentions: { parse: [] } });
      for (const r of reactions) await message.react(r);
      return message.id;
    } catch (e) {
      console.error("Discord: message not posted:", e.message);
      return null;
    }
  }

  // Without these permissions, the voice connection hangs without a clear message
  missingPerms(channel) {
    const perms = channel.permissionsFor(this.me);
    return ["ViewChannel", "Connect", "Speak"].filter((flag) => !perms || !perms.has(PermissionFlagsBits[flag]));
  }

  // Rank of the member in the "follow" list (-1 if absent)
  followRank(member) {
    if (!member || member.user.bot) return -1;
    const names = [member.id, member.user.username, member.user.globalName, member.displayName, member.nickname]
      .filter(Boolean).map((x) => x.toLowerCase());
    return this.follow.findIndex((f) => names.includes(f));
  }

  isFollowed(member) {
    return this.followRank(member) >= 0;
  }

  // Voice channel of the highest-priority followed member currently in voice
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
    console.log(`Discord: following into voice channel "${channel.name}"`);
  }

  // builder: a SlashCommandBuilder; handler(interaction) returns the reply
  addCommand(builder, handler) {
    this.commands.set(builder.name, { builder, handler });
  }

  async registerCommands(guild) {
    if (!this.commands.size) return;
    try {
      // Server commands (not global ones): available immediately
      await guild.commands.set([...this.commands.values()].map((c) => c.builder.toJSON()));
      console.log(`Discord: commands ${[...this.commands.keys()].map((n) => "/" + n).join(" ")} available`);
    } catch (e) {
      console.log(`Discord: cannot add the commands (${e.message}). Re-invite the bot with the applications.commands scope (see README).`);
    }
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const command = this.commands.get(interaction.commandName);
      if (!command) return;
      try {
        const reply = await command.handler(interaction);
        if (reply) await interaction.reply(reply);
      } catch (e) {
        console.error(`Command /${interaction.commandName}:`, e.message);
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
    // When disconnected (region change, network cut…), try to come back before giving up
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.connection.destroy();
        console.log("Discord: disconnected from voice, retrying in 5 s");
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
