"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildStartModal } = require("../commands/panelViews");
const panelInteractions = require("../commands/panelInteractions");
const { IDS } = require("../commands/customIds");

const VALID_TOKEN_BASE = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`;

test("buildStartModal renders multi-line token input with paragraph style", () => {
    const modal = buildStartModal();
    const json = modal.toJSON();
    assert.equal(json.custom_id, IDS.MODAL_START);
    assert.equal(json.title, "ออนช่องเสียง");
    assert.equal(json.components.length, 3);

    const tokenInput = json.components[0].components[0];
    assert.equal(tokenInput.custom_id, IDS.FIELD_TOKEN);
    assert.equal(tokenInput.style, 2); // 2 is PARAGRAPH in Discord API
    assert.match(tokenInput.label, /1 บรรทัดต่อ 1 บัญชี/);
    assert.match(tokenInput.placeholder, /1-10 บัญชี/);
});

test("validateStartFields validates batch token counts and format constraints", () => {
    const { validateStartFields } = panelInteractions._test;
    const validServer = "123456789012345678";
    const validVoice = "876543210987654321";
    const validToken = VALID_TOKEN_BASE;

    // 0 tokens
    assert.match(
        validateStartFields({ tokens: [], serverId: validServer, voiceId: validVoice }),
        /กรุณากรอกอย่างน้อย 1 Token/
    );

    // More than 10 tokens
    const elevenTokens = Array(11).fill(validToken);
    assert.match(
        validateStartFields({ tokens: elevenTokens, serverId: validServer, voiceId: validVoice }),
        /สูงสุดไม่เกิน 10 Token/
    );

    // Invalid server ID
    assert.match(
        validateStartFields({ tokens: [validToken], serverId: "123", voiceId: validVoice }),
        /ไอดีเซิร์ฟเวอร์ไม่ถูกต้อง/
    );

    // Invalid voice channel ID
    assert.match(
        validateStartFields({ tokens: [validToken], serverId: validServer, voiceId: "abc" }),
        /ไอดีช่องเสียงไม่ถูกต้อง/
    );

    // All invalid tokens
    assert.match(
        validateStartFields({ tokens: ["invalid_token_1", "invalid_token_2"], serverId: validServer, voiceId: validVoice }),
        /รูปแบบ Token ไม่ถูกต้อง/
    );

    // Valid 1 token
    assert.equal(
        validateStartFields({ tokens: [validToken], serverId: validServer, voiceId: validVoice }),
        null
    );

    // Valid 10 tokens
    const tenTokens = Array(10).fill(validToken);
    assert.equal(
        validateStartFields({ tokens: tenTokens, serverId: validServer, voiceId: validVoice }),
        null
    );
});

test("handleModal executes batch tokens and reports success and failure breakdown", async () => {
    const validServer = "123456789012345678";
    const validVoice = "876543210987654321";
    const validToken1 = `${"a".repeat(24)}.${"b".repeat(6)}.${"1".repeat(27)}`;
    const validToken2 = `${"a".repeat(24)}.${"b".repeat(6)}.${"2".repeat(27)}`;
    const validToken3 = `${"a".repeat(24)}.${"b".repeat(6)}.${"3".repeat(27)}`;

    let replyPayload = null;
    const interaction = {
        customId: IDS.MODAL_START,
        fields: {
            getTextInputValue(id) {
                if (id === IDS.FIELD_TOKEN) return `${validToken1}\n${validToken2}\n${validToken3}`;
                if (id === IDS.FIELD_SERVER_ID) return validServer;
                if (id === IDS.FIELD_VOICE_ID) return validVoice;
                return "";
            }
        },
        user: { id: "owner-1", tag: "Owner#0001", displayAvatarURL: () => null },
        guild: { id: validServer },
        deferReply: async () => {},
        editReply: async (payload) => {
            replyPayload = payload;
            return payload;
        }
    };

    let panelUpdated = 0;
    const mockDeps = {
        shadowMasterId: "owner-1",
        updatePanel: async () => { panelUpdated++; }
    };

    // Mock ensureVoiceSession on getVoiceWorker
    const voiceWorker = require("../voiceWorker");
    const originalEnsure = voiceWorker.ensureVoiceSession;
    let callCount = 0;
    voiceWorker.ensureVoiceSession = async (input) => {
        callCount++;
        if (input.token === validToken2) {
            return { ok: false, action: "TOKEN_INVALID" };
        }
        return {
            ok: true,
            sessionId: `sess-${callCount}`,
            session: {
                accountTag: `AltUser_${callCount}#0000`,
                voiceId: validVoice
            },
            action: "created"
        };
    };

    try {
        await panelInteractions.handleModal(interaction, { guilds: { cache: new Map() } }, mockDeps);
        assert.ok(replyPayload);
        assert.match(replyPayload.content, /เริ่มระบบสำเร็จ! \(2\/3 บัญชี\)/);
        assert.match(replyPayload.content, /AltUser_1/);
        assert.match(replyPayload.content, /AltUser_3/);
        assert.match(replyPayload.content, /รายการที่ล้มเหลว \(1 บัญชี\)/);
        assert.match(replyPayload.content, /ลำดับที่ 2/);
        assert.match(replyPayload.content, new RegExp(`<#${validVoice}>`));
        assert.ok(panelUpdated >= 1);
    } finally {
        voiceWorker.ensureVoiceSession = originalEnsure;
    }
});
