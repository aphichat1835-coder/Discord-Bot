const { safeAuditText } = require("./logCore");

const CSV_COLUMNS = Object.freeze([
    "createdAt",
    "eventId",
    "guildId",
    "category",
    "severity",
    "actionType",
    "actorId",
    "targetId",
    "channelId",
    "messageId",
    "roleId",
    "reason",
    "summary"
]);

function csvEscape(value) {
    const text = sanitizeCsvFormula(safeAuditText(value ?? "", 1000).replaceAll(/\r?\n/g, " "));
    return `"${text.replaceAll("\"", "\"\"")}"`;
}

function sanitizeCsvFormula(value) {
    const text = String(value ?? "");
    return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function recordsToCsv(records = []) {
    const rows = [CSV_COLUMNS.join(",")];
    for (const record of records) {
        rows.push(CSV_COLUMNS.map(column => csvEscape(record?.[column])).join(","));
    }
    return rows.join("\n");
}

function recordsToJson(records = []) {
    return JSON.stringify(records, null, 2);
}

function recordsToMarkdown(records = []) {
    const rows = ["| Time | Action | Actor | Target | Summary |", "|---|---|---|---|---|"];
    for (const record of records) {
        rows.push(`| ${safeAuditText(record.createdAt || "-", 80)} | ${safeAuditText(record.actionType || "-", 80)} | ${safeAuditText(record.actorId || "-", 80)} | ${safeAuditText(record.targetId || "-", 80)} | ${safeAuditText(record.summary || "-", 180)} |`);
    }
    return rows.join("\n");
}

module.exports = {
    CSV_COLUMNS,
    csvEscape,
    sanitizeCsvFormula,
    recordsToCsv,
    recordsToJson,
    recordsToMarkdown
};
