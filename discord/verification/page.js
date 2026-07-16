"use strict";

const { createViewHelpers } = require("../index/viewHelpers");
const { BASE_CSS } = require("../index/viewStyles");
const { OWNER_VERIFICATION_CSS } = require("./ownerStyles");

const { navBar, shell } = createViewHelpers(`${BASE_CSS}${OWNER_VERIFICATION_CSS}`);

function verificationHomePage() {
    return shell("ยืนยันตัวตน", String.raw`
<div class="verify-shell">
${navBar("/verification")}

<section class="verify-hero" aria-labelledby="verification-title">
  <div class="verify-hero-main">
    <p class="verify-kicker">Owner verification</p>
    <h1 id="verification-title" class="verify-title">จัดการระบบยืนยันตัวตนใน Dashboard เดียว</h1>
    <p class="verify-lead">เลือกเซิร์ฟเวอร์เพื่อเปิดสถานะ การตั้งค่า แผง เงื่อนไข และข้อมูลสมาชิก โดยยังอยู่ในศูนย์ควบคุมเจ้าของบอท</p>
  </div>
  <aside class="verify-hero-side" aria-label="สถานะแหล่งข้อมูล">
    <div class="verify-live"><span class="verify-live-dot" aria-hidden="true"></span><div><b>ข้อมูลสดจากบอท</b><small>รายชื่อมาจากเซิร์ฟเวอร์ที่บอทมองเห็นในขณะนี้</small></div></div>
    <div class="verify-live"><span class="badge badge-info">Owner only</span><div><b>ใช้สิทธิ์ Dashboard เดิม</b><small>ไม่ต้อง Login หรือเปิดเว็บไซต์จัดการอีกชุด</small></div></div>
  </aside>
</section>

<section class="verify-panel" aria-labelledby="guild-directory-title">
  <div class="verify-panel-head">
    <div><p class="verify-kicker">Server directory</p><h2 id="guild-directory-title">เลือกเซิร์ฟเวอร์</h2><p>ค้นหาด้วยชื่อหรือ Guild ID แล้วเปิดพื้นที่จัดการของเซิร์ฟเวอร์นั้น</p></div>
  </div>
  <div class="verify-toolbar">
    <div><label for="guild-search">ค้นหาเซิร์ฟเวอร์</label><input id="guild-search" type="search" placeholder="ชื่อเซิร์ฟเวอร์หรือ Guild ID" autocomplete="off"></div>
    <div id="guild-count" class="verify-count">กำลังโหลด…</div>
  </div>
  <div id="guild-status" class="verify-loading" role="status" aria-live="polite"><div class="spinner"></div>กำลังโหลดเซิร์ฟเวอร์…</div>
  <div id="guilds" class="verify-guild-grid" aria-live="polite"></div>
</section>
</div>
<script>
(function(){
  'use strict';
  const root=document.getElementById('guilds');
  const status=document.getElementById('guild-status');
  const count=document.getElementById('guild-count');
  const search=document.getElementById('guild-search');
  let guilds=[];

  function initials(name){
    return String(name||'S').trim().split(/\\s+/).slice(0,2).map(function(part){return part[0]||'';}).join('').toUpperCase()||'S';
  }

  function iconNode(guild,name){
    const wrap=document.createElement('div');
    wrap.className='verify-guild-icon';
    const id=String(guild.id||'');
    const hash=String(guild.icon||'');
    if(/^\\d{17,22}$/.test(id)&&/^[A-Za-z0-9_]+$/.test(hash)){
      const image=document.createElement('img');
      image.src='https://cdn.discordapp.com/icons/'+id+'/'+hash+'.webp?size=128';
      image.alt='';
      image.addEventListener('error',function(){wrap.textContent=initials(name);},{once:true});
      wrap.appendChild(image);
    }else wrap.textContent=initials(name);
    return wrap;
  }

  function card(guild){
    const id=String(guild.id||'');
    const name=String(guild.name||id||'ไม่ทราบชื่อเซิร์ฟเวอร์');
    const link=document.createElement('a');
    const top=document.createElement('div');
    const text=document.createElement('div');
    const title=document.createElement('div');
    const meta=document.createElement('div');
    const open=document.createElement('div');
    link.className='verify-guild-card';
    link.href='/verification/'+encodeURIComponent(id);
    link.setAttribute('aria-label','เปิดระบบยืนยันตัวตนของ '+name);
    top.className='verify-guild-top';
    title.className='verify-guild-name';
    title.textContent=name;
    meta.className='verify-guild-id';
    meta.textContent='Guild ID: '+id;
    text.style.minWidth='0';
    text.append(title,meta);
    top.append(iconNode(guild,name),text);
    open.className='verify-guild-open';
    open.append(document.createTextNode('เปิดพื้นที่จัดการ'),document.createTextNode('→'));
    link.append(top,open);
    link.addEventListener('click',function(){
      status.hidden=false;
      status.className='verify-loading';
      status.replaceChildren();
      const spinner=document.createElement('div');
      spinner.className='spinner';
      status.append(spinner,document.createTextNode('กำลังเปิด '+name+'…'));
    });
    return link;
  }

  function render(){
    const query=String(search.value||'').trim().toLowerCase();
    const visible=guilds.filter(function(guild){return !query||String(guild.name||'').toLowerCase().includes(query)||String(guild.id||'').includes(query);});
    root.replaceChildren(...visible.map(card));
    count.textContent='แสดง '+visible.length+' จาก '+guilds.length+' เซิร์ฟเวอร์';
    status.hidden=visible.length>0;
    if(!visible.length){status.className='empty';status.textContent=query?'ไม่พบเซิร์ฟเวอร์ที่ตรงกับคำค้น':'บอทยังไม่พบเซิร์ฟเวอร์ที่จัดการได้';}
  }

  async function load(){
    try{
      const response=await fetch('/api/guilds',{headers:{Accept:'application/json'}});
      const data=await response.json().catch(function(){return null;});
      if(!response.ok||!data||data.success===false) throw new Error(data&&data.error||'โหลดรายชื่อไม่สำเร็จ');
      guilds=Array.isArray(data.guilds)?data.guilds:[];
      render();
    }catch(error){
      status.hidden=false;
      status.className='alert alert-danger';
      status.textContent=error&&error.message||'โหลดรายชื่อเซิร์ฟเวอร์ไม่สำเร็จ';
      count.textContent='โหลดไม่สำเร็จ';
    }
  }

  search.addEventListener('input',render);
  load();
})();
</script>`);
}

module.exports = { verificationHomePage };
