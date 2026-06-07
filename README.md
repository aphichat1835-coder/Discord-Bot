# Phomueangtai Enterprise Discord System

ระบบนี้เป็นโปรเจกต์ **Discord bot + web dashboard + OAuth2 verification** แบบแยก 2 service สำหรับจัดการบอท Discord, ระบบยืนยันตัวตน, การให้ยศ, logging, dashboard และงานดูแลเซิร์ฟเวอร์

> หมายเหตุความปลอดภัย: ห้าม commit token จริง, API key, database URL, password, webhook URL, `.env` หรือ secret ใด ๆ ลง GitHub เด็ดขาด ให้ใช้ `.env.example` เป็น template เท่านั้น

---

## Overview

โปรเจกต์นี้มี 2 ส่วนหลัก:

- **Service 1 — Main Discord Bot**: บอทหลักสำหรับ slash commands, owner/admin dashboard routes, voice/session subsystems, audit logging, panel และระบบคำสั่งต่าง ๆ
- **Service 2 — Dashboard Public / Verification Dashboard**: เว็บสำหรับ Discord OAuth2 verification, guild-admin dashboard foundation, internal APIs, verification logs, risk/device/IP summaries และการให้ยศผ่าน bot token

โปรเจกต์นี้เหมาะกับการทำระบบยืนยันตัวตนของสมาชิก Discord ผ่าน OAuth2 และระบบ dashboard สำหรับเจ้าของโปรเจกต์หรือแอดมินเซิร์ฟเวอร์

สถานะปัจจุบัน: **work in progress** แต่ระบบ OAuth2 verification core ผ่านการทดสอบใช้งานจริงแล้ว

---

## Features

### เสร็จแล้ว / Stable enough for current phase

- Discord bot startup + Express server
- MongoDB connection
- Slash command registration
- `/setup-verify` สำหรับสร้างแผงยืนยันตัวตน
- OAuth2 verification callback ผ่าน `dashboard-public`
- Role assignment หลังยืนยันสำเร็จ
- Repeat verification handling: ถ้ามียศอยู่แล้ว ไม่ให้ซ้ำและไม่ DM ซ้ำ
- Success/failure callback page
- Verification logging และ IP/device/risk summary foundation
- `.env.example`, `.gitignore`, `README.md`, `CONTEXT.md`, `AGENTS.md` สำหรับช่วยให้ AI ทำงานต่อแม่นขึ้น

### กำลังพัฒนา / Planned

- Dashboard Public renovation
- Owner Dashboard expansion
- Data deletion / retention controls
- Owner-only sensitive reveal controls
- Security Center / env checker
- Full route guard and crypto audit
- Audit Log improvements หลังระบบ verify/dashboard เสถียร

---

## Tech Stack

- Runtime: Node.js `>=18.0.0`
- Language: JavaScript / CommonJS
- Package manager: npm
- Bot framework: `discord.js` v13
- Voice: `@discordjs/voice`, `opusscript`, `libsodium-wrappers`, `tweetnacl`
- Web framework: Express
- Database: MongoDB ผ่าน Mongoose
- Sessions: `express-session` + `connect-mongo` ใน Service 2
- Deployment target: Render หรือ Node-compatible hosting provider

---

## Project Structure

```txt
.
├── package.json                     # Service 1 package, entry point: discord/index.js
├── package-lock.json                # npm lock file for Service 1
├── render.yaml                      # Render Blueprint draft สำหรับ deploy แบบ 2 services
├── .env.example                     # ตัวอย่าง environment variables แบบ placeholder
├── .gitignore                       # กัน secrets/generated files ไม่ให้หลุดเข้า Git
├── README.md                        # คู่มือสำหรับคนและ AI
├── CONTEXT.md                       # บริบทเชิงลึกของโปรเจกต์สำหรับ AI agent
├── AGENTS.md                        # กฎสำหรับ AI coding agent
├── discord/
│   ├── index.js                     # Service 1 boot sequence: Express → MongoDB → Discord
│   ├── commands.js                  # Slash command registry/router
│   ├── commands/
│   │   ├── moderation.js
│   │   ├── information.js
│   │   ├── utility.js
│   │   └── verification.js          # Logic ของ /setup-verify
│   ├── index/
│   │   ├── server.js                # Service 1 API routes
│   │   ├── views.js                 # Service 1 HTML routes
│   │   ├── system.js                # System/crash/cron helpers
│   │   ├── events.js                # Discord event registration
│   │   └── verifyOwner.js           # Owner-only reveal approval route foundation
│   ├── features/
│   ├── auditLogger.js
│   ├── sessionManager.js
│   ├── systemProvider.js
│   └── voiceWorker.js
└── dashboard-public/
    ├── package.json                 # Service 2 package, entry point: index.js
    ├── package-lock.json            # npm lock file for Service 2
    ├── index.js                     # Service 2 Express app
    ├── routes/
    │   ├── oauth.js                 # OAuth2 callback + admin OAuth
    │   ├── guild.js                 # Guild admin dashboard routes/API foundation
    │   └── api.js                   # Internal/public dashboard APIs
    ├── models/
    │   ├── GuildConfig.js
    │   ├── OAuthUser.js
    │   ├── VerifyLog.js
    │   ├── IpIdentityLink.js
    │   └── IPRevealRequest.js
    ├── utils/
    │   ├── crypto.js
    │   ├── discordAPI.js
    │   └── ipUtils.js
    ├── views/
    │   ├── callback.html
    │   ├── home.html
    │   ├── guilds.html
    │   └── guild.html
    └── public/
```

---

## Requirements

ก่อนรันโปรเจกต์ต้องมี:

- Node.js `>=18.0.0`
- npm
- MongoDB connection string
- Discord Application และ bot token จาก Discord Developer Portal
- Discord OAuth2 redirect URIs สำหรับ Service 2
- Environment variables ที่จำเป็นใน local `.env` หรือ Render Environment Variables

---

## Installation

### Service 1 — Main Bot

รันจาก root repo:

```bash
npm install
```

### Service 2 — Dashboard Public

รันจากโฟลเดอร์ `dashboard-public`:

```bash
cd dashboard-public
npm install
```

---

## Environment Variables

สร้าง `.env` เองจาก `.env.example` สำหรับ local development หรือใส่ค่าใน Render Environment Variables สำหรับ production

```bash
cp .env.example .env
```

ห้าม commit `.env` และห้ามใส่ค่าจริงใน `.env.example`

Service 1 ต้องใช้หลัก ๆ:

```txt
MONGO_URI
TOKEN_MANAGER
API_SECRET
ENCRYPTION_KEY
NODE_ENV
```

Service 2 ต้องใช้หลัก ๆ:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ENCRYPTION_KEY
DASHBOARD_URL หรือ PUBLIC_DASHBOARD_URL
TRUST_PROXY=false # optional, เปิด true เฉพาะเมื่ออยู่หลัง reverse proxy ที่เชื่อถือได้
TRUST_PROXY_HOPS=1 # optional, จำนวน proxy hops ที่เชื่อถือเมื่อ TRUST_PROXY=true
ENABLE_CF_IP_HEADER=false # optional, เปิด true เฉพาะเมื่ออยู่หลัง Cloudflare ที่เชื่อถือได้
```

Legacy raw OAuth snapshot cleanup (manual only, do not run automatically on service start):

```bash
node dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js --dry-run
node dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js --apply
```

Discord Developer Portal OAuth2 Redirect URIs ที่ต้องตั้งสำหรับ Service 2:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

---

## Running Locally

### Service 1 — Main Bot

```bash
npm start
```

หรือ:

```bash
npm run dev
```

ทั้งสองคำสั่งรัน:

```bash
node discord/index.js
```

### Service 2 — Dashboard Public

```bash
cd dashboard-public
npm start
```

หรือ:

```bash
cd dashboard-public
npm run dev
```

ทั้งสองคำสั่งรัน:

```bash
node index.js
```

---

## Testing / Validation

ตอนนี้ยังไม่มี automated `npm test` script ใน `package.json`

ใช้ basic syntax checks เหล่านี้ก่อน deploy:

### Service 1

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/verification.js
```

### Service 2

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
```

HTML files เช่น `dashboard-public/views/callback.html` ควรตรวจด้วย browser หรือ HTML validator

### Smoke test สำหรับระบบ verification

1. ใช้ `/setup-verify` แบบใส่แค่ `channel` และ `role`
2. ใช้ `/setup-verify` พร้อม `button_text: ✅ ยืนยันตัวตน ✅`
3. ตรวจว่า bot ส่ง panel ได้โดยไม่มี `Invalid Form Body`
4. กด verify ด้วยบัญชีปกติ
5. ตรวจว่า OAuth redirect กลับมาที่ Service 2 ถูกต้อง
6. ตรวจว่า role ถูกให้จริง
7. กดซ้ำด้วยบัญชีที่มียศอยู่แล้ว
8. ตรวจว่าไม่มี DM ซ้ำและ role ไม่หาย
9. ทดสอบบัญชีใหม่ถ้าเปิด account-age policy
10. ตรวจว่า failure page ไม่โชว์ debug details
11. ตรวจ Render logs ว่าไม่มี major runtime errors

---

## Deployment

โปรเจกต์นี้ deploy ได้แบบแยก 2 Render Web Services

### Option A — Manual Render setup

### Service 1 — Main Bot

- Root Directory: repository root
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables: ดู `.env.example`

### Service 2 — Dashboard Public

- Root Directory: `dashboard-public`
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables: ดู `.env.example`

### Option B — Render Blueprint

มีไฟล์ `render.yaml` สำหรับใช้เป็น Render Blueprint แบบ 2 services:

```txt
Service 1: discord-bot-4hjp
Service 2: discordbot-dashboard-public
```

ก่อนใช้ `render.yaml` จริง ต้องเช็กชื่อ service ใน Render Dashboard ให้ตรงกับของจริง เพราะถ้าชื่อไม่ตรง Render อาจสร้าง service ใหม่แทนการอัปเดตของเดิม

`render.yaml` ไม่เก็บ secret จริง ให้ตั้งค่า environment variables ใน Render Dashboard ตาม `.env.example`

Deploy Service 1 เมื่อแก้ไฟล์ใต้ `discord/`
Deploy Service 2 เมื่อแก้ไฟล์ใต้ `dashboard-public/`

ห้ามใส่ secret ลง GitHub ให้ใส่ใน Render Environment Variables เท่านั้น

---

## Legacy docs status

เอกสารเก่าอย่าง `DEPLOYMENT_2_SERVICES.md` และ `RENDER_DEPLOYMENT.md` เป็นข้อมูลช่วยจำรุ่นก่อน ข้อมูลสำคัญถูกย้าย/สรุปไว้ใน `README.md`, `CONTEXT.md`, `.env.example` และ `render.yaml` แล้ว

ถ้า review แล้วไม่มีข้อมูลใหม่เพิ่ม สามารถลบหรือย้ายไป `docs/legacy/` ได้

---

## Safety / Security Notes

- ห้าม commit `.env`
- ห้าม hardcode Discord bot token
- ห้าม log token, OAuth token, password, database URL หรือ webhook URL
- ห้ามเก็บ Discord user token
- ห้ามทำ selfbot หรือ token grabber flow
- ใช้ Discord bot token และ OAuth2 scopes แบบโปร่งใสเท่านั้น
- ถ้า token หรือ secret หลุด ให้ rotate ทันที
- ตรวจ AI-generated code ก่อนรันหรือ deploy เสมอ
- เก็บ raw IP หรือข้อมูลละเอียดอ่อนให้ owner-only และต้องมี audit log
- อย่าเปิด debug details ให้ public user เห็น

---

## Troubleshooting

| ปัญหา | จุดที่ควรตรวจ |
|---|---|
| Bot ไม่ start | `TOKEN_MANAGER`, `MONGO_URI`, `API_SECRET`, `ENCRYPTION_KEY` |
| Dashboard Public ไม่ start | `MONGO_URI`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_MANAGER` |
| OAuth redirect fail | Redirect URI ใน Discord Developer Portal ต้องตรงกับ Service 2 URL |
| ให้ยศไม่ได้ | Bot role hierarchy, target role, `TOKEN_MANAGER` ใน Service 2, bot permissions |
| Panel button invalid | OAuth URL length, `PUBLIC_DASHBOARD_URL`, emoji format |
| Debug โผล่หน้าเว็บ | `callback.html` ต้อง keep public debug disabled |
| Render build fail | ตรวจ Node version, build command, environment variables |
| Render Blueprint สร้าง service ใหม่ | เช็ก `name` ใน `render.yaml` ว่าตรงกับ service เดิมใน Render หรือไม่ |

---

## Useful Commands

```bash
# Git status
git status --short --untracked-files=all

# ดู diff ก่อน commit
git diff -- README.md CONTEXT.md AGENTS.md .gitignore .env.example render.yaml package-lock.json dashboard-public/package-lock.json .replit

# Install Service 1
npm install

# Start Service 1
npm start

# Install Service 2
cd dashboard-public
npm install

# Start Service 2
cd dashboard-public
npm start
```

---

## Maintainer Notes

ก่อนให้ AI แก้โค้ด ให้สั่งให้อ่าน:

```txt
AGENTS.md
CONTEXT.md
README.md
package.json
dashboard-public/package.json
```

ก่อนทำงานใหญ่ ให้สร้าง backup branch หรือ tag:

```bash
git branch backup/verify-core-stable-before-next-phase
# หรือ
git tag verify-core-stable-before-next-phase
```

ก่อน deploy ให้ตรวจ:

```txt
- ไม่มี .env ถูก track
- ไม่มี secret ใน diff
- validation commands ผ่าน
- smoke test plan พร้อม
- รู้ว่าต้อง redeploy Service 1 หรือ Service 2
```
