"use strict";

function verificationHomePage() {
    return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#07110f">
  <meta name="color-scheme" content="dark">
  <title>Verification Control — เลือกเซิร์ฟเวอร์</title>
  <link rel="stylesheet" href="/verification-assets/css/dashboard.css">
  <link rel="stylesheet" href="/verification-assets/css/workspace.css">
</head>
<body class="owner-dashboard-theme">
  <a class="skip-link" href="#main-content">ข้ามไปเนื้อหาหลัก</a>
  <main id="main-content" class="page-shell" tabindex="-1">
   <div class="owner-page-content">
    <header class="verification-commandbar">
      <a class="verification-mark" href="/" aria-label="กลับศูนย์ควบคุม">
        <span class="verification-mark-symbol" aria-hidden="true">V</span>
        <span><b>VERIFY CONTROL</b><small>Phomueangtai · Owner workspace</small></span>
      </a>
      <nav class="verification-commandbar-actions" aria-label="ทางลัด">
        <a class="btn btn-soft" href="/">ศูนย์ควบคุม</a>
        <a class="btn btn-soft" href="/join-campaign">ดึงสมาชิก</a>
      </nav>
    </header>

    <section class="verification-intro">
      <div>
        <p class="eyebrow">VERIFICATION WORKSPACE</p>
        <h1 class="title-lg">เลือกพื้นที่ที่ต้องการจัดการ</h1>
        <p class="hero-desc">เซิร์ฟเวอร์หนึ่งใบคือทางเข้าเดียวไปยังการตั้งค่าแผง สมาชิก ประวัติ ความเสี่ยง และข้อมูลส่วนตัว ไม่ต้องไล่หาหลายหน้า</p>
      </div>
      <div class="verification-intro-note">
        <span class="status-beacon" aria-hidden="true"></span>
        <div><b>ข้อมูลสดจากบอท</b><small>รายการนี้อ้างอิงเซิร์ฟเวอร์ที่บอทมองเห็นในขณะนี้</small></div>
      </div>
    </section>
    <section class="card card-pad section-card mt-18" aria-labelledby="guild-list-title">
      <div class="card-header">
        <div>
          <p class="eyebrow">SERVER DIRECTORY</p>
          <h2 id="guild-list-title">เซิร์ฟเวอร์ทั้งหมด</h2>
          <p class="card-desc">ค้นหาแล้วแตะเพียงครั้งเดียวเพื่อเปิด Workspace ของเซิร์ฟเวอร์นั้น</p>
        </div>
      </div>
      <div class="guild-toolbar">
        <div class="guild-search-wrap">
          <label for="guild-search">ค้นหาเซิร์ฟเวอร์</label>
          <input id="guild-search" type="search" placeholder="พิมพ์ชื่อหรือ Guild ID…" autocomplete="off">
        </div>
        <div id="guild-count" class="guild-count">กำลังโหลด…</div>
      </div>
      <div id="status" class="loading-box" role="status" aria-live="polite">กำลังโหลดเซิร์ฟเวอร์…</div>
      <div id="guilds" class="guild-grid" aria-live="polite"></div>
    </section>
   </div>
  </main>
  <script>
  (function(){
    const status=document.getElementById('status');
    const root=document.getElementById('guilds');
    const count=document.getElementById('guild-count');
    const search=document.getElementById('guild-search');
    let guilds=[];

    function initials(name){
      return String(name||'S').trim().split(/\s+/).slice(0,2).map(function(part){return part[0]||'';}).join('').toUpperCase()||'S';
    }

    function guildCard(guild){
      const id=String(guild.id||'');
      const name=String(guild.name||id||'ไม่ทราบชื่อเซิร์ฟเวอร์');
      const card=document.createElement('a');
      card.className='guild-card';
      card.href='/verification/'+encodeURIComponent(id);
      card.setAttribute('aria-label','จัดการระบบยืนยันตัวตนของ '+name);

      const icon=document.createElement('div');
      icon.className='guild-card-icon';
      const iconHash=String(guild.icon||'');
      if(/^\w{2,}$/.test(iconHash)&&/^\d{17,22}$/.test(id)){
        const image=document.createElement('img');
        image.src='https://cdn.discordapp.com/icons/'+id+'/'+iconHash+'.webp?size=128';
        image.alt='';
        image.addEventListener('error',function(){icon.textContent=initials(name);});
        icon.appendChild(image);
      }else{
        icon.textContent=initials(name);
      }

      const title=document.createElement('div');
      title.className='guild-card-name';
      title.textContent=name;
      const meta=document.createElement('div');
      meta.className='guild-card-meta';
      meta.textContent='Guild ID: '+id;
      card.append(icon,title,meta);
      return card;
    }

    function render(){
      const query=String(search.value||'').trim().toLowerCase();
      const visible=guilds.filter(function(guild){
        return !query||String(guild.name||'').toLowerCase().includes(query)||String(guild.id||'').includes(query);
      });
      root.replaceChildren(...visible.map(guildCard));
      count.textContent='แสดง '+visible.length+' จาก '+guilds.length+' เซิร์ฟเวอร์';
      status.className=visible.length?'muted small':'empty-state';
      status.textContent=visible.length?'เลือกเซิร์ฟเวอร์เพื่อเริ่มจัดการ':query?'ไม่พบเซิร์ฟเวอร์ที่ตรงกับคำค้น ลองใช้ Guild ID':'ยังไม่มีเซิร์ฟเวอร์ที่บอทเข้าถึงได้';
    }

    async function loadGuilds(){
      status.className='loading-box';
      status.textContent='กำลังโหลดเซิร์ฟเวอร์…';
      root.replaceChildren();
      try{
        const response=await fetch('/api/guilds',{headers:{Accept:'application/json'}});
        const data=await response.json().catch(function(){return null;});
        if(!response.ok||!data||!data.success) throw new Error(data&&data.error||'โหลดข้อมูลไม่สำเร็จ');
        guilds=Array.isArray(data.guilds)?data.guilds:[];
        render();
      }catch(err){
        status.className='alert alert-danger';
        status.textContent=(err&&err.message)||'โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรชหน้า';
        count.textContent='โหลดไม่สำเร็จ';
      }
    }

    search.addEventListener('input',render);
    loadGuilds();
  })();
  </script>
</body>
</html>`;
}

module.exports = { verificationHomePage };
