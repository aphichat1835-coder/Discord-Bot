const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    guildId:   { type: String, required: true, unique: true },
    guildName: String,

    verification: {
        enabled:             { type: Boolean, default: false },
        roleId:              String,
        channelId:           String,
        messageId:           String,
        blockVPN:            { type: Boolean, default: true },
        minAccountAgeDays:   { type: Number,  default: 7 },
        requireEmail:        { type: Boolean, default: false },
        requireConnections:  { type: Boolean, default: false }
    },

    setupBy:   String,
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
});

module.exports = mongoose.model('GuildConfig', schema);
