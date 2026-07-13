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
    ["/approved", "✅ Approved"],
    ["/verification", "🛡️ Verification"],
    ["/join-campaign", "📥 Join"],
    ["/docs", "📖 คู่มือ"],
    ["/logs", "📜 Logs"],
    ["/logs/voice", "🔊 Voice"]
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

function csrfFetchScript() {
    return `
<script>
(function(){
    const nativeFetch=window.fetch.bind(window);
    function readCookie(name){
        const parts=document.cookie ? document.cookie.split(';') : [];
        for(const part of parts){
            const idx=part.indexOf('=');
            if(idx<0) continue;
            let key='';
            try{key=decodeURIComponent(part.slice(0,idx).trim());}
            catch{continue;}
            if(key===name){
                try{return decodeURIComponent(part.slice(idx+1).trim());}
                catch{return '';}
            }
        }
        return '';
    }
    window.fetch=function(input,init){
        const opts=init ? Object.assign({},init) : {};
        const method=String(opts.method || (input && input.method) || 'GET').toUpperCase();
        const rawUrl=typeof input==='string' ? input : String(input && input.url || '');
        const sameOrigin=rawUrl.startsWith('/') || rawUrl.startsWith(window.location.origin);
        if(sameOrigin && !['GET','HEAD','OPTIONS'].includes(method)){
            const headers=new Headers(opts.headers || {});
            if(!headers.has('x-csrf-token')){
                const token=readCookie('__da_csrf');
                if(token) headers.set('x-csrf-token',token);
            }
            opts.headers=headers;
        }
        return nativeFetch(input,opts);
    };
})();
</script>`;
}

function createViewHelpers(baseCss) {
    function shell(title, body) {
        return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Phomueangtai Enterprise</title>
<style>${baseCss}</style>
</head><body>${body}${csrfFetchScript()}</body></html>`;
    }

    return {
        escapeHtml,
        navBar,
        shell,
        csrfFetchScript,
        toastScript
    };
}

module.exports = {
    escapeHtml,
    createViewHelpers
};
