function getVoiceAccountLabel(session) {
    if (!session) return "ไม่ทราบบัญชี";

    if (session.accountGlobalName && session.accountUsername) {
        return `${session.accountGlobalName} (@${session.accountUsername})`;
    }

    return session.accountTag ||
        session.accountUsername ||
        session.accountGlobalName ||
        session.accountId ||
        "ไม่ทราบบัญชี";
}

function getVoiceChannelLabel(session) {
    if (!session) return "-";

    const name = session.voiceName ? `# ${session.voiceName}` : null;
    const mention = session.voiceId ? `<#${session.voiceId}>` : null;

    if (name && mention) return `${name}\n${mention}`;
    return mention || name || "-";
}

function getVoiceStatusLabel(session, config) {
    const st = session?.connection?.state?.status;

    if (!st || st === "destroyed" || st === "disconnected") {
        return `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`;
    }

    if (st === "ready") {
        return `${config.emojis.status_online} เชื่อมต่ออยู่`;
    }

    return `${config.emojis.signal} กำลังเชื่อมต่อ`;
}

module.exports = {
    getVoiceAccountLabel,
    getVoiceChannelLabel,
    getVoiceStatusLabel
};
