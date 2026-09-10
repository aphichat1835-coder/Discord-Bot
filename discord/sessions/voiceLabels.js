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

    if (st === "ready" && !session?.reconnecting) {
        return `${config.emojis.status_online} เชื่อมต่ออยู่`;
    }

    const recovery = session?.recoveryState;
    if (recovery?.phase === "hibernate" || (recovery?.hibernateUntil && recovery.hibernateUntil > Date.now())) {
        if (recovery.hibernateUntil) {
            const timeUnix = Math.floor(recovery.hibernateUntil / 1000);
            return `💤 พักรอกู้คืนอัตโนมัติ (รอบใหม่ <t:${timeUnix}:R>)`;
        }
        return "💤 พักรอกู้คืนอัตโนมัติ";
    }

    if (session?.reconnecting || recovery?.phase === "recovering") {
        const attempt = recovery?.attempts || 1;
        return `🔄 กำลังกู้คืน (รอบที่ ${attempt})...`;
    }

    if (st === "connecting" || st === "signalling") {
        return `${config.emojis.signal} กำลังเชื่อมต่อ`;
    }

    return `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`;
}

module.exports = {
    getVoiceAccountLabel,
    getVoiceChannelLabel,
    getVoiceStatusLabel
};
