'use strict';

const tokenCoordinator = require('./tokenCoordinator');
const oauthTokenManager = require('./oauthTokenManager');

module.exports = {
    tokenCoordinator,
    oauthTokenManager,
    TokenCoordinator: tokenCoordinator.TokenCoordinator
};
