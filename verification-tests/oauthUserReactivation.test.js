"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const OAuthUser = require("../discord/verification/models/OAuthUser");
const {
    readVerificationResult,
    isVerificationActivationUpdate,
    applyVerificationReactivation
} = require("../discord/verification/utils/softDeleteLifecycle");

function verificationUpdate(result) {
    return {
        $set: {
            lastVerify: {
                guildId: "12345678901234567",
                result,
                attemptStartedAt: 100,
                verifiedAt: 200
            },
            deletedAt: 50,
            deletedBy: "owner"
        },
        $unset: { legacyDeletionReason: 1 }
    };
}

test("successful verification clears OAuthUser soft-delete markers", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const update = verificationUpdate("success");

    assert.equal(readVerificationResult(update), "success");
    assert.equal(isVerificationActivationUpdate(update), true);
    assert.equal(applyVerificationReactivation(update), true);
    assert.equal(Object.hasOwn(update.$set, "deletedAt"), false);
    assert.equal(Object.hasOwn(update.$set, "deletedBy"), false);
    assert.deepEqual(update.$unset, {
        legacyDeletionReason: 1,
        deletedAt: 1,
        deletedBy: 1
    });
});

for (const result of ["failed", "blocked", "verified", ""]) {
    test(`${result || "missing"} verification result does not reactivate a deleted user`, () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
        const update = verificationUpdate(result);

        assert.equal(isVerificationActivationUpdate(update), false);
        assert.equal(applyVerificationReactivation(update), false);
        assert.equal(update.$set.deletedAt, 50);
        assert.equal(update.$set.deletedBy, "owner");
        assert.deepEqual(update.$unset, { legacyDeletionReason: 1 });
    });
}

test("dotted successful verification result supports atomic field updates", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const update = {
        $set: {
            "lastVerify.result": "SUCCESS",
            "oauth.encryptedAccessToken": "encrypted"
        }
    };

    assert.equal(readVerificationResult(update), "success");
    assert.equal(applyVerificationReactivation(update), true);
    assert.deepEqual(update.$unset, { deletedAt: 1, deletedBy: 1 });
});

test("unrelated OAuth updates do not reactivate a deleted user", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const update = {
        $set: {
            "oauth.encryptedAccessToken": "encrypted",
            updatedAt: 200
        }
    };

    assert.equal(readVerificationResult(update), null);
    assert.equal(isVerificationActivationUpdate(update), false);
    assert.equal(applyVerificationReactivation(update), false);
    assert.equal(update.$unset, undefined);
});

test("OAuthUser persists verification attempt ordering metadata", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(OAuthUser.schema.path("lastVerify.attemptStartedAt"));
    assert.ok(OAuthUser.schema.path("deletedAt"));
    assert.ok(OAuthUser.schema.path("deletedBy"));
});
