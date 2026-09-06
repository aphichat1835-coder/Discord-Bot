function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

const NAV_GROUPS = [
    ["ภาพรวม", [
        ["/", "🏠 หน้าหลัก"],
        ["/status", "📊 สถานะระบบ"]
    ]],
    ["จัดการ", [
        ["/settings", "⚙️ ตั้งค่าบอท"],
        ["/commands", "⚡ คำสั่ง"],
        ["/approved", "✅ เซิร์ฟเวอร์"]
    ]],
    ["สมาชิก", [
        ["/verification", "🛡️ ยืนยันตัวตน"],
        ["/join-campaign", "📥 ดึงสมาชิก"]
    ]],
    ["ติดตามและช่วยเหลือ", [
        ["/logs", "📜 บันทึกระบบ"],
        ["/logs/voice", "🔊 บันทึกเสียง"],
        ["/docs", "📖 คู่มือ"]
    ]]
];

function navBar(active = "") {
    return `<nav class="nav" aria-label="เมนูหลักของ Owner Dashboard">${NAV_GROUPS.map(([group, links]) =>
        `<div class="nav-group"><span class="nav-group-label">${group}</span><div class="nav-group-links">${links.map(([href, label]) =>
            `<a href="${href}"${href === active ? " class=\"active\" aria-current=\"page\"" : ""}>${label}</a>`
        ).join("")}</div></div>`
    ).join("")}<div class="nav-actions"><button type="button" class="nav-logout" onclick="dashboardLogout(this)">🚪 ออกจากระบบ</button></div></nav>`;
}

function toastScript() {
    return `
<div class="toast" id="__toast" role="status" aria-live="polite" aria-atomic="true"></div>
<script>
function showToast(msg,type){
    type=type||'ok';
    const t=document.getElementById('__toast');
    t.textContent=msg;
    t.className='toast '+type;
    t.classList.add('show');
    clearTimeout(t.__t);
    t.__t=setTimeout(()=>t.classList.remove('show'),3800);
}
</script>`;
}

function dashboardUxScript() {
    return `<script>
(function(){
    window.dashboardInterval=function(callback,delay){
        return window.setInterval(function(){
            if(!document.hidden) callback();
        },delay);
    };
    window.setDashboardButtonBusy=function(button,busy,label){
        if(!button) return;
        if(busy){
            button.dataset.idleText=button.textContent;
            button.disabled=true;
            button.setAttribute('aria-busy','true');
            if(label) button.textContent=label;
            return;
        }
        button.disabled=false;
        button.removeAttribute('aria-busy');
        if(button.dataset.idleText) button.textContent=button.dataset.idleText;
    };
    window.dashboardLogout=async function(button){
        window.setDashboardButtonBusy(button,true,'กำลังออก...');
        try{
            const response=await window.fetch('/auth/logout',{method:'POST'});
            if(!response.ok) throw new Error('logout_failed');
            window.location.assign('/auth/pin');
        }catch{
            window.setDashboardButtonBusy(button,false);
            if(typeof window.showToast==='function') window.showToast('❌ ออกจากระบบไม่สำเร็จ','err');
        }
    };
    document.addEventListener('keydown',function(event){
        if(event.key!=='Escape') return;
        const openModal=[...document.querySelectorAll('.modal')].find(function(modal){
            return getComputedStyle(modal).display!=='none';
        });
        if(!openModal) return;
        const close=openModal.querySelector('.modal-close');
        if (close) close.click();
        else openModal.style.display='none';
    });
    window.applyGradientText=function(target,options){
        var opts=options||{};
        var el=typeof target==='string'?document.querySelector(target):target;
        if(!el) return;
        el.classList.add('gradient-text');
        if(opts.speed) el.style.setProperty('--gt-speed',opts.speed+'s');
        if(opts.accent) el.classList.add('gradient-text-accent');
        if(opts.align) el.style.textAlign=opts.align;
    };
})();
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
        let sameOrigin=false;
        try{
            const target=new URL(rawUrl || window.location.href,window.location.href);
            sameOrigin=target.origin===window.location.origin;
        }catch{
            sameOrigin=false;
        }
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
<meta name="theme-color" content="#07050f"><meta name="color-scheme" content="dark">
<title>${title} — Phomueangtai Enterprise</title>
<style>${baseCss}</style>
</head><body><a class="skip-link" href="#main-content">ข้ามไปเนื้อหาหลัก</a>
<div class="ambient-layer" aria-hidden="true"><span></span><span></span></div>
${dashboardUxScript()}<main id="main-content" tabindex="-1">${body}</main>${csrfFetchScript()}</body></html>`;
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
