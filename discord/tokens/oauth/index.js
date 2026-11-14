"use strict";

const {
    encryptToken,
    decryptToken,
    decryptTokenForMigration
} = require("../../verification/utils/crypto");

const config = require("./config");
const state = require("./state");
const tokenValidation = require("./tokenValidation");
const lockManager = require("./lockManager");
const tokenStorage = require("./tokenStorage");
const refreshState = require("./refreshState");
const refreshService = require("./refreshService");
const candidateQuery = require("./candidateQuery");
const ownerTokenService = require("./ownerTokenService");
const migrationService = require("./migrationService");
const revocationService = require("./revocationService");
const scheduler = require("./scheduler");

const oauthTokenManager = {
    DEFAULT_REFRESH_MARGIN_MS: config.DEFAULT_REFRESH_MARGIN_MS,
    DEFAULT_REFRESH_SCAN_LIMIT: config.DEFAULT_REFRESH_SCAN_LIMIT,
    DEFAULT_REFRESH_FAIL_MAX: config.DEFAULT_REFRESH_FAIL_MAX,
    DEFAULT_REFRESH_INTERVAL_MS: config.DEFAULT_REFRESH_INTERVAL_MS,
    DEFAULT_ON_DEMAND_MARGIN_MS: config.DEFAULT_ON_DEMAND_MARGIN_MS,
    REQUIRED_USER_SCOPES: config.REQUIRED_USER_SCOPES,
    TOKEN_FIELDS: config.TOKEN_FIELDS,

    getPublicBaseUrl: config.getPublicBaseUrl,
    getVerificationRedirectUri: config.getVerificationRedirectUri,
    getOAuthRefreshConfig: config.getOAuthRefreshConfig,
    validateTokenData: tokenValidation.validateTokenData,
    prepareStoredToken: tokenStorage.prepareStoredToken,
    exchangeAuthorizationCode: tokenStorage.exchangeAuthorizationCode,
    commitVerificationActivation: tokenStorage.commitVerificationActivation,
    withTokenRefreshLock: lockManager.withTokenRefreshLock,
    withOAuthTokenStateLock: lockManager.withTokenRefreshLock,
    getAccessToken: refreshService.getAccessToken,
    refreshDueTokens: refreshService.refreshDueTokens,
    listAccessTokenCandidates: candidateQuery.listAccessTokenCandidates,
    getOwnerTokenState: ownerTokenService.getOwnerTokenState,
    getOwnerTokenMetadata: ownerTokenService.getOwnerTokenMetadata,
    getRecoveryStatuses: ownerTokenService.getRecoveryStatuses,
    recoveryReasonLabel: tokenValidation.recoveryReasonLabel,
    tokenRecoveryReasons: tokenValidation.tokenRecoveryReasons,
    migrateStoredTokenEncryption: migrationService.migrateStoredTokenEncryption,
    revokeToken: revocationService.revokeToken,
    start: scheduler.start,
    stop: scheduler.stop,
    getDiagnostics: scheduler.getDiagnostics,

    _test: {
        dispatchOAuthAlert: state.dispatchOAuthAlert,
        resolveFailMax: config.resolveFailMax,
        isInvalidGrantError: refreshState.isInvalidGrantError,
        assertValidTokenField: tokenValidation.assertValidTokenField,
        validateTokenData: tokenValidation.validateTokenData,
        tokenPath: tokenStorage.tokenPath,
        versionCondition: tokenStorage.versionCondition,
        conflictOutcome: refreshState.conflictOutcome,
        readFreshOAuthDocument: refreshState.readFreshOAuthDocument,
        markRefreshFailure: refreshState.markRefreshFailure,
        performTokenRefreshUnderLock: refreshService.performTokenRefreshUnderLock,
        buildRefreshQuery: refreshState.buildRefreshQuery,
        refreshStateIsDue: refreshState.refreshStateIsDue,
        applyRefreshOutcome: refreshState.applyRefreshOutcome,
        refreshTokenField: refreshService.refreshTokenField,
        revealTokenStateForOwner: ownerTokenService.revealTokenStateForOwner,
        tokenMetadataState: ownerTokenService.tokenMetadataState,
        checkTokenCryptoReasons: tokenValidation.checkTokenCryptoReasons,
        collectMissingScopeReasons: tokenValidation.collectMissingScopeReasons,
        resetInternalStateForTesting: state.resetInternalStateForTesting,
        refreshLocks: state.refreshLocks,
        encryptToken,
        decryptToken,
        decryptTokenForMigration
    }
};

module.exports = oauthTokenManager;
