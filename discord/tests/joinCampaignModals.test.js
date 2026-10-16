"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ComponentType, TextInputStyle } = require("discord.js");

const modeRegistry = require("../features/joinCampaign/modes/modeRegistry");
const {
    CUSTOM_IDS,
    buildBaseSetupModal,
    buildStartOptionsModal
} = require("../features/joinCampaign/ui/modals");

test("CUSTOM_IDS: contains frozen modal and field constants", () => {
    assert.ok(Object.isFrozen(CUSTOM_IDS), "CUSTOM_IDS should be frozen");
    assert.equal(CUSTOM_IDS.MODAL_SETUP_PREFIX, "join_camp_modal_setup:");
    assert.equal(CUSTOM_IDS.MODAL_START, "join_camp_modal_start");
    assert.equal(CUSTOM_IDS.FIELD_SOURCE, "join_camp_field_source");
    assert.equal(CUSTOM_IDS.FIELD_TARGET, "join_camp_field_target");
    assert.equal(CUSTOM_IDS.FIELD_AMOUNT, "join_camp_field_amount");
    assert.equal(CUSTOM_IDS.FIELD_WEBHOOK, "join_camp_field_webhook");
});

test("buildBaseSetupModal: creates valid modal with LabelBuilder wrapping TextInput for ALL_TO_TARGET mode", () => {
    const mode = modeRegistry.getMode("ALL_TO_TARGET");
    const currentState = { targetGuildId: "123456789012345678" };
    const modal = buildBaseSetupModal({ mode, currentState });

    assert.equal(modal.data.custom_id, `${CUSTOM_IDS.MODAL_SETUP_PREFIX}ALL_TO_TARGET`);
    assert.equal(modal.data.title, `ตั้งค่าเซิร์ฟเวอร์ (${mode.label})`.slice(0, 45));
    assert.equal(modal.components.length, 1);

    const serialized = modal.toJSON();
    assert.equal(serialized.custom_id, `${CUSTOM_IDS.MODAL_SETUP_PREFIX}ALL_TO_TARGET`);
    assert.equal(serialized.title, `ตั้งค่าเซิร์ฟเวอร์ (${mode.label})`.slice(0, 45));
    assert.equal(serialized.components.length, 1);

    const targetLabelComp = serialized.components[0];
    assert.equal(targetLabelComp.type, ComponentType.Label, "Root component must be Label (type 18)");
    assert.equal(targetLabelComp.label, "ไอดีเซิร์ฟเวอร์ปลายทาง");

    const innerInput = targetLabelComp.component;
    assert.equal(innerInput.type, ComponentType.TextInput, "Inner component must be TextInput (type 4)");
    assert.equal(innerInput.custom_id, CUSTOM_IDS.FIELD_TARGET);
    assert.equal(innerInput.style, TextInputStyle.Short);
    assert.equal(innerInput.required, true);
    assert.equal(innerInput.min_length, 17);
    assert.equal(innerInput.max_length, 22);
    assert.equal(innerInput.value, "123456789012345678");
    assert.ok(innerInput.placeholder && innerInput.placeholder.length > 0);
});

test("buildBaseSetupModal: creates valid modal with LabelBuilder for GUILD_TO_GUILD mode with both source and target inputs", () => {
    const mode = modeRegistry.getMode("GUILD_TO_GUILD");
    const currentState = {
        sourceGuildId: "987654321098765432",
        targetGuildId: "123456789012345678"
    };
    const modal = buildBaseSetupModal({ mode, currentState });

    assert.equal(modal.data.custom_id, `${CUSTOM_IDS.MODAL_SETUP_PREFIX}GUILD_TO_GUILD`);
    assert.equal(modal.data.title, `ตั้งค่าเซิร์ฟเวอร์ (${mode.label})`.slice(0, 45));
    assert.equal(modal.components.length, 2);

    const serialized = modal.toJSON();
    assert.equal(serialized.components.length, 2);

    // Source Guild field
    const sourceLabelComp = serialized.components[0];
    assert.equal(sourceLabelComp.type, ComponentType.Label);
    assert.equal(sourceLabelComp.label, "ไอดีเซิร์ฟเวอร์ต้นทาง");
    assert.equal(sourceLabelComp.component.type, ComponentType.TextInput);
    assert.equal(sourceLabelComp.component.custom_id, CUSTOM_IDS.FIELD_SOURCE);
    assert.equal(sourceLabelComp.component.style, TextInputStyle.Short);
    assert.equal(sourceLabelComp.component.required, true);
    assert.equal(sourceLabelComp.component.min_length, 17);
    assert.equal(sourceLabelComp.component.max_length, 22);
    assert.equal(sourceLabelComp.component.value, "987654321098765432");

    // Target Guild field
    const targetLabelComp = serialized.components[1];
    assert.equal(targetLabelComp.type, ComponentType.Label);
    assert.equal(targetLabelComp.label, "ไอดีเซิร์ฟเวอร์ปลายทาง");
    assert.equal(targetLabelComp.component.type, ComponentType.TextInput);
    assert.equal(targetLabelComp.component.custom_id, CUSTOM_IDS.FIELD_TARGET);
    assert.equal(targetLabelComp.component.style, TextInputStyle.Short);
    assert.equal(targetLabelComp.component.required, true);
    assert.equal(targetLabelComp.component.min_length, 17);
    assert.equal(targetLabelComp.component.max_length, 22);
    assert.equal(targetLabelComp.component.value, "123456789012345678");
});

test("buildBaseSetupModal: defaults currentState to empty object without errors", () => {
    const mode = modeRegistry.getMode("ALL_TO_TARGET");
    const modal = buildBaseSetupModal({ mode });

    const serialized = modal.toJSON();
    assert.equal(serialized.components.length, 1);
    const innerInput = serialized.components[0].component;
    assert.equal(innerInput.custom_id, CUSTOM_IDS.FIELD_TARGET);
    assert.equal(innerInput.value, undefined, "Value should be undefined when currentState is empty");
});

test("buildStartOptionsModal: creates valid modal with LabelBuilder wrapping amountInput and webhookInput", () => {
    const modal = buildStartOptionsModal();

    assert.equal(modal.data.custom_id, CUSTOM_IDS.MODAL_START);
    assert.equal(modal.data.title, "เริ่มดึงสมาชิกเข้าเซิร์ฟเวอร์");
    assert.equal(modal.components.length, 2);

    const serialized = modal.toJSON();
    assert.equal(serialized.custom_id, CUSTOM_IDS.MODAL_START);
    assert.equal(serialized.title, "เริ่มดึงสมาชิกเข้าเซิร์ฟเวอร์");
    assert.equal(serialized.components.length, 2);

    // Component 0: amountInput wrapped in Label
    const amountLabelComp = serialized.components[0];
    assert.equal(amountLabelComp.type, ComponentType.Label, "Root component 0 must be Label (type 18)");
    assert.equal(amountLabelComp.label, "จำนวนสมาชิกที่ต้องการดึง (เว้นว่าง = ทั้งหมด)");

    const amountInput = amountLabelComp.component;
    assert.equal(amountInput.type, ComponentType.TextInput, "Inner component 0 must be TextInput (type 4)");
    assert.equal(amountInput.custom_id, CUSTOM_IDS.FIELD_AMOUNT);
    assert.equal(amountInput.placeholder, "เช่น 50, 100, 500 (ปล่อยว่างเพื่อดึงทั้งหมดที่พร้อม)");
    assert.equal(amountInput.style, TextInputStyle.Short);
    assert.equal(amountInput.required, false);

    // Component 1: webhookInput wrapped in Label
    const webhookLabelComp = serialized.components[1];
    assert.equal(webhookLabelComp.type, ComponentType.Label, "Root component 1 must be Label (type 18)");
    assert.equal(webhookLabelComp.label, "ลิงก์ Webhook รายงานผล (ไม่บังคับ)");

    const webhookInput = webhookLabelComp.component;
    assert.equal(webhookInput.type, ComponentType.TextInput, "Inner component 1 must be TextInput (type 4)");
    assert.equal(webhookInput.custom_id, CUSTOM_IDS.FIELD_WEBHOOK);
    assert.equal(webhookInput.placeholder, "https://discord.com/api/webhooks/...");
    assert.equal(webhookInput.style, TextInputStyle.Short);
    assert.equal(webhookInput.required, false);
});

test("Discord API Schema compatibility: modals serialize cleanly without deprecated structures", () => {
    const mode = modeRegistry.getMode("ALL_TO_TARGET");
    const setupModal = buildBaseSetupModal({ mode });
    const startModal = buildStartOptionsModal();

    for (const m of [setupModal, startModal]) {
        const json = m.toJSON();
        assert.ok(typeof json.custom_id === "string" && json.custom_id.length > 0);
        assert.ok(typeof json.title === "string" && json.title.length > 0 && json.title.length <= 45);
        assert.ok(Array.isArray(json.components) && json.components.length > 0);

        for (const comp of json.components) {
            // Type 18: Label Component
            assert.equal(comp.type, ComponentType.Label);
            assert.ok(typeof comp.label === "string" && comp.label.length > 0);
            assert.ok(comp.component, "Label component must contain a nested component");
            assert.equal(comp.component.type, ComponentType.TextInput);
            assert.ok(typeof comp.component.custom_id === "string");
            assert.ok(comp.component.style === 1 || comp.component.style === 2);
        }
    }
});
