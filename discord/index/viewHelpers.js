function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function createViewHelpers(baseCss) {
    function navBar(active = "") {
        const links = [
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

        return `<nav class="nav">${links.map(([href, label]) =>
            `<a href="${href}"${href === active ? " class=\"active\"" : ""}>${label}</a>`
        ).join("")}</nav>`;
    }

    function shell(title, body) {
        return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Phomueangtai Enterprise</title>
<style>${baseCss}</style>
</head><body>${body}</body></html>`;
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
