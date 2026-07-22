"use strict";

const {
    ActionRowBuilder,
    ActivityType,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    GatewayIntentBits,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const LEGACY_BUTTON_STYLES = Object.freeze({
    PRIMARY: ButtonStyle.Primary,
    SECONDARY: ButtonStyle.Secondary,
    SUCCESS: ButtonStyle.Success,
    DANGER: ButtonStyle.Danger,
    LINK: ButtonStyle.Link,
    PREMIUM: ButtonStyle.Premium
});

const LEGACY_TEXT_INPUT_STYLES = Object.freeze({
    SHORT: TextInputStyle.Short,
    PARAGRAPH: TextInputStyle.Paragraph
});

const LEGACY_ACTIVITY_TYPES = Object.freeze({
    PLAYING: ActivityType.Playing,
    STREAMING: ActivityType.Streaming,
    LISTENING: ActivityType.Listening,
    WATCHING: ActivityType.Watching,
    CUSTOM: ActivityType.Custom,
    COMPETING: ActivityType.Competing
});

const LEGACY_CHANNEL_TYPES = Object.freeze({
    GUILD_TEXT: ChannelType.GuildText,
    DM: ChannelType.DM,
    GUILD_VOICE: ChannelType.GuildVoice,
    GROUP_DM: ChannelType.GroupDM,
    GUILD_CATEGORY: ChannelType.GuildCategory,
    GUILD_NEWS: ChannelType.GuildAnnouncement,
    GUILD_STORE: ChannelType.GuildStore,
    GUILD_NEWS_THREAD: ChannelType.AnnouncementThread,
    GUILD_PUBLIC_THREAD: ChannelType.PublicThread,
    GUILD_PRIVATE_THREAD: ChannelType.PrivateThread,
    GUILD_STAGE_VOICE: ChannelType.GuildStageVoice,
    GUILD_DIRECTORY: ChannelType.GuildDirectory,
    GUILD_FORUM: ChannelType.GuildForum,
    GUILD_MEDIA: ChannelType.GuildMedia
});

const CHANNEL_TYPE_NAMES = new Map(
    Object.entries(LEGACY_CHANNEL_TYPES)
        .filter(([, value]) => Number.isInteger(value))
        .map(([name, value]) => [value, name])
);

class MessageEmbed extends EmbedBuilder {
    addField(name, value, inline = false) {
        return this.addFields({ name, value, inline });
    }
}

class MessageButton extends ButtonBuilder {
    get customId() {
        return this.data.custom_id;
    }

    setStyle(style) {
        return super.setStyle(LEGACY_BUTTON_STYLES[style] ?? style);
    }
}

class TextInputComponent extends TextInputBuilder {
    setStyle(style) {
        return super.setStyle(LEGACY_TEXT_INPUT_STYLES[style] ?? style);
    }
}

function resolveChannelType(type) {
    return LEGACY_CHANNEL_TYPES[type] ?? type;
}

function getLegacyChannelType(type) {
    if (typeof type === "string") return type;
    return CHANNEL_TYPE_NAMES.get(type) || "UNKNOWN";
}

function resolveActivityType(type) {
    return LEGACY_ACTIVITY_TYPES[type] ?? type;
}

const Intents = Object.freeze({
    FLAGS: Object.freeze({
        GUILDS: GatewayIntentBits.Guilds,
        GUILD_MEMBERS: GatewayIntentBits.GuildMembers,
        GUILD_MESSAGES: GatewayIntentBits.GuildMessages,
        GUILD_VOICE_STATES: GatewayIntentBits.GuildVoiceStates,
        MESSAGE_CONTENT: GatewayIntentBits.MessageContent
    })
});

module.exports = {
    Intents,
    MessageActionRow: ActionRowBuilder,
    MessageButton,
    MessageEmbed,
    MessageSelectMenu: StringSelectMenuBuilder,
    Modal: ModalBuilder,
    TextInputComponent,
    getLegacyChannelType,
    resolveActivityType,
    resolveChannelType
};
