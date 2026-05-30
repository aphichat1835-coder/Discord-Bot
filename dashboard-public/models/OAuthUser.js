const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    discord: {
        userId:        { type: String, required: true },
        username:      String,
        globalName:    String,
        avatarHash:    String,
        email:         String,
        emailVerified: Boolean
    },
    oauth: {
        encryptedAccessToken:  String,
        encryptedRefreshToken: String,
        expiresAt: Number,
        scope:     String
    },
    connections: [{
        type:     String,
        id:       String,
        name:     String,
        verified: Boolean
    }],
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
});

schema.index({ 'discord.userId': 1 }, { unique: true });
module.exports = mongoose.model('OAuthUser', schema);
