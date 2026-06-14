function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

const NAV_LINKS = [
    ["/", "🏠 หน้าหลัก"],
    ["/status", "📊 สถานะ"],
    ["/settings", "⚙️ ตั้งค่า"],
    ["/commands", "⚡ คำสั่ง"],
    ["/whitelist", "📋 Whitelist"],
    ["/approved", "✅ Approved"],
    ["/docs", "📖 คู่มือ"],
    ["/logs", "📜 Logs"],
    ["/logs/voice", "🔊 Voice"],
];

function navBar(active = "") {
    return `<nav class="nav">${NAV_LINKS.map(([href, label]) =>
        `<a href="${href}"${href === active ? " class=\"active\"" : ""}>${label}</a>`
    ).join("")}</nav>`;
}

function toastScript() {
    return `
<div class="toast" id="__toast"></div>
<script>
function showToast(msg,type){
    type=type||'ok';
    const t=document.getElementById('__toast');
    t.textContent=msg;
    t.className='toast '+type;
    t.style.display='block';
    clearTimeout(t.__t);
    t.__t=setTimeout(()=>t.style.display='none',3800);
}
</script>`;
}

function createViewHelpers(baseCss) {
    function shell(title, body) {
        return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Phomueangtai Enterprise</title>
<style>${baseCss}</style>
</head><body>${body}</body></html>`;
    }

    return {
        escapeHtml,
        navBar,
        shell,
        toastScript
    };
}

module.exports = {
    escapeHtml,
    createViewHelpers
};
