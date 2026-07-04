"use strict";

function verificationHomePage() {
    return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Owner Verification</title>
  <link rel="stylesheet" href="/verification-assets/css/dashboard.css">
</head>
<body>
  <main class="page-shell">
    <section class="hero-card">
      <div>
        <p class="eyebrow">OWNER ONLY</p>
        <h1>Verification Dashboard</h1>
        <p class="muted">เลือกเซิร์ฟเวอร์ที่บอทอยู่เพื่อจัดการ Panel, Logs, Members, Stats และ Risk</p>
      </div>
      <a class="btn btn-soft" href="/">← Owner Dashboard</a>
    </section>
    <section class="section-card">
      <div id="status" class="muted">กำลังโหลดเซิร์ฟเวอร์…</div>
      <div id="guilds" class="guild-grid"></div>
    </section>
  </main>
  <script>
  (async function(){
    const status=document.getElementById('status');
    const root=document.getElementById('guilds');
    try{
      const response=await fetch('/api/guilds');
      const data=await response.json();
      if(!response.ok||!data.success) throw new Error(data.error||'โหลดข้อมูลไม่สำเร็จ');
      const guilds=Array.isArray(data.guilds)?data.guilds:[];
      status.textContent=guilds.length?'พบ '+guilds.length+' เซิร์ฟเวอร์':'ไม่พบเซิร์ฟเวอร์ที่บอทอยู่';
      root.innerHTML=guilds.map(function(guild){
        const id=encodeURIComponent(String(guild.id||''));
        const name=String(guild.name||guild.id||'Unknown').replace(/[&<>"']/g,function(ch){
          return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
        });
        return '<a class="guild-card" href="/verification/'+id+'"><strong>'+name+'</strong><span>'+id+'</span></a>';
      }).join('');
    }catch(err){
      status.textContent=err.message||'โหลดข้อมูลไม่สำเร็จ';
    }
  })();
  </script>
</body>
</html>`;
}

module.exports = { verificationHomePage };
