"use strict";

const mongoose = require("mongoose");
const { buildChunkSnapshotSchema } = require("../utils/chunkSnapshotSchema");

const schema = buildChunkSnapshotSchema();

module.exports = mongoose.models.OAuthUserConnectionSnapshot ||
    mongoose.model("OAuthUserConnectionSnapshot", schema);
