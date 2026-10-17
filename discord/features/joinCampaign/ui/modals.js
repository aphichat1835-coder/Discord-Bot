"use strict";

const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    LabelBuilder
} = require("discord.js");

const CUSTOM_IDS = Object.freeze({
    MODAL_SETUP_PREFIX: "join_camp_modal_setup:",
    MODAL_START: "join_camp_modal_start",
    FIELD_SOURCE: "join_camp_field_source",
    FIELD_TARGET: "join_camp_field_target",
    FIELD_AMOUNT: "join_camp_field_amount",
    FIELD_WEBHOOK: "join_camp_field_webhook"
});

function buildBaseSetupModal({ mode, currentState = {} }) {
    const customId = `${CUSTOM_IDS.MODAL_SETUP_PREFIX}${mode.id}`;
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(`ตั้งค่าเซิร์ฟเวอร์ (${mode.label})`.slice(0, 45));

    const fields = mode.getBaseModalFields(currentState);
    const labels = [];

    for (const field of fields) {
        const inputId = field.id === "source_guild_id" ? CUSTOM_IDS.FIELD_SOURCE : CUSTOM_IDS.FIELD_TARGET;
        const textInput = new TextInputBuilder()
            .setCustomId(inputId)
            .setPlaceholder(field.placeholder || "")
            .setStyle(TextInputStyle.Short)
            .setRequired(Boolean(field.required))
            .setMinLength(17)
            .setMaxLength(22);

        if (field.value) {
            textInput.setValue(String(field.value));
        }

        const label = new LabelBuilder()
            .setLabel(field.label)
            .setTextInputComponent(textInput);

        labels.push(label);
    }

    modal.addLabelComponents(labels);
    return modal;
}

function buildStartOptionsModal() {
    const modal = new ModalBuilder()
        .setCustomId(CUSTOM_IDS.MODAL_START)
        .setTitle("เริ่มดึงสมาชิกเข้าเซิร์ฟเวอร์");

    const amountInput = new TextInputBuilder()
        .setCustomId(CUSTOM_IDS.FIELD_AMOUNT)
        .setPlaceholder("เช่น 50, 100, 500 (ปล่อยว่างเพื่อดึงทั้งหมดที่พร้อม)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const amountLabel = new LabelBuilder()
        .setLabel("จำนวนสมาชิกที่ต้องการดึง (เว้นว่าง = ทั้งหมด)")
        .setTextInputComponent(amountInput);

    const webhookInput = new TextInputBuilder()
        .setCustomId(CUSTOM_IDS.FIELD_WEBHOOK)
        .setPlaceholder("https://discord.com/api/webhooks/...")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const webhookLabel = new LabelBuilder()
        .setLabel("ลิงก์ Webhook รายงานผล (ไม่บังคับ)")
        .setTextInputComponent(webhookInput);

    modal.addLabelComponents([
        amountLabel,
        webhookLabel
    ]);

    return modal;
}

module.exports = {
    CUSTOM_IDS,
    buildBaseSetupModal,
    buildStartOptionsModal
};
