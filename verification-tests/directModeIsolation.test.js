"use strict";

const verificationCommand = require("../discord/commands/verification");
const verificationOrchestrator = require("../discord/verification/services/verificationOrchestrator");
const { verificationWebhookManager } = require("../discord/verification/services/webhook/verificationWebhookManager");
const GuildConfig = require("../discord/verification/models/GuildConfig");

describe("Direct Mode vs OAuth2 Verification Isolation Suite", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("Direct Mode button interaction only assigns role and never invokes OAuth2 Orchestrator or Webhook Manager", async () => {
        const orchestratorSpy = jest.spyOn(verificationOrchestrator, "executeVerification");
        const webhookSpy = jest.spyOn(verificationWebhookManager, "startLiveMode");
        const triggerWorkerSpy = jest.spyOn(verificationWebhookManager, "triggerWorker");

        const targetRoleId = "123456789012345678";
        const memberRoles = new Set();
        let repliedPayload = null;

        const fakeRole = {
            id: targetRoleId,
            name: "VerifiedMember",
            position: 5,
            managed: false,
            toString: () => `<@&${targetRoleId}>`
        };

        const fakeMember = {
            id: "987654321098765432",
            roles: {
                cache: {
                    has: (id) => memberRoles.has(id)
                },
                add: async (id) => {
                    memberRoles.add(id);
                    return true;
                }
            }
        };

        const fakeBotMember = {
            id: "111222333444555666",
            permissions: {
                has: () => true
            },
            roles: {
                highest: { position: 10 }
            }
        };

        const fakeGuild = {
            id: "123123123123123123",
            roles: {
                cache: {
                    get: (id) => (id === targetRoleId ? fakeRole : null)
                }
            },
            members: {
                cache: {
                    get: () => fakeBotMember
                }
            }
        };

        const fakeInteraction = {
            customId: `verify_role_${targetRoleId}`,
            member: fakeMember,
            guild: fakeGuild,
            client: { user: { id: "111222333444555666" } },
            message: { id: "123456789012345678" },
            reply: async (payload) => {
                repliedPayload = payload;
                return payload;
            }
        };

        // Mock loadCurrentDirectConfig via GuildConfig findOne
        jest.spyOn(GuildConfig, "findOne").mockReturnValue({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            enabled: true,
                            roleId: targetRoleId,
                            messageId: "123456789012345678",
                            panelRevision: "rev-1",
                            verifyType: "direct"
                        }
                    })
                })
            })
        });

        await verificationCommand.handleVerifyButton(fakeInteraction);

        // Verify role was granted
        expect(memberRoles.has(targetRoleId)).toBe(true);
        expect(repliedPayload).toBeDefined();
        expect(repliedPayload.embeds).toBeDefined();

        // Verify isolation: OAuth2 Orchestrator and Webhook Manager were NEVER called
        expect(orchestratorSpy).not.toHaveBeenCalled();
        expect(webhookSpy).not.toHaveBeenCalled();
        expect(triggerWorkerSpy).not.toHaveBeenCalled();
    });

    test("Direct Mode correctly reports when member already has the role without calling external subsystems", async () => {
        const orchestratorSpy = jest.spyOn(verificationOrchestrator, "executeVerification");
        const webhookSpy = jest.spyOn(verificationWebhookManager, "triggerWorker");

        const targetRoleId = "123456789012345678";
        let repliedPayload = null;

        const fakeRole = {
            id: targetRoleId,
            name: "VerifiedMember",
            position: 5,
            managed: false,
            toString: () => `<@&${targetRoleId}>`
        };

        const fakeMember = {
            id: "987654321098765432",
            roles: {
                cache: {
                    has: (id) => id === targetRoleId
                },
                add: async () => {
                    throw new Error("should_not_be_called");
                }
            }
        };

        const fakeBotMember = {
            id: "111222333444555666",
            permissions: { has: () => true },
            roles: { highest: { position: 10 } }
        };

        const fakeGuild = {
            id: "123123123123123123",
            roles: { cache: { get: () => fakeRole } },
            members: { cache: { get: () => fakeBotMember } }
        };

        const fakeInteraction = {
            customId: `verify_role_${targetRoleId}`,
            member: fakeMember,
            guild: fakeGuild,
            client: { user: { id: "111222333444555666" } },
            message: { id: "123456789012345678" },
            reply: async (payload) => {
                repliedPayload = payload;
                return payload;
            }
        };

        jest.spyOn(GuildConfig, "findOne").mockReturnValue({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            enabled: true,
                            roleId: targetRoleId,
                            messageId: "123456789012345678",
                            panelRevision: "rev-1",
                            verifyType: "direct"
                        }
                    })
                })
            })
        });

        await verificationCommand.handleVerifyButton(fakeInteraction);

        expect(repliedPayload?.content).toMatch(/คุณมียศ.*อยู่แล้ว/);
        expect(orchestratorSpy).not.toHaveBeenCalled();
        expect(webhookSpy).not.toHaveBeenCalled();
    });

    test("Legacy OAuth button returns update prompt without executing role assignment or orchestrator", async () => {
        const orchestratorSpy = jest.spyOn(verificationOrchestrator, "executeVerification");
        let repliedPayload = null;

        const fakeInteraction = {
            customId: "verify_oauth_legacy_button",
            reply: async (payload) => {
                repliedPayload = payload;
                return payload;
            }
        };

        await verificationCommand.handleVerifyButton(fakeInteraction);

        expect(repliedPayload?.content).toMatch(/แผงยืนยันนี้เป็นแผงเก่าแล้ว/);
        expect(orchestratorSpy).not.toHaveBeenCalled();
    });
});
