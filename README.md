# Phomueangtai Enterprise Discord System

ระบบนี้เป็นโปรเจกต์ **Discord bot + web dashboard + OAuth2 verification** แบบแยก 2 service สำหรับจัดการบอท Discord, ระบบยืนยันตัวตน, การให้ยศ, logging, dashboard และงานดูแลเซิร์ฟเวอร์

> Security note: ห้าม commit ค่า credential จริง, API key, database URL, password, webhook URL, `.env` หรือ secret ใด ๆ ลง GitHub ให้ใช้ `.env.example` เป็น template เท่านั้น

---

## Overview

โปรเจกต์นี้มี 2 service หลัก:

- **Service 1 — Main Discord Bot**: บอทหลักสำหรับ slash commands, owner/admin dashboard routes, voice/session subsystems, audit logging, panel และระบบคำสั่งต่าง ๆ
- **Service 2 — Dashboard Public / Verification Dashboard**: เว็บสำหรับ Discord OAuth2 verification, guild-admin dashboard foundation, internal APIs, verification logs, risk/device/IP summaries และการให้ยศผ่าน bot credentials ฝั่ง server

สถานะปัจจุบัน: **work in progress** แต่ระบบ OAuth2 verification core ผ่านการทดสอบใช้งานจริงใน phase ปัจจุบันแล้ว

---

## Features

### Stable enough for current phase

- Discord bot startup + Express server
- MongoDB connection
- Slash command registration
- `/setup-verify` สำหรับสร้างแผงยืนยันตัวตน
- Discord OAuth2 verification callback ผ่าน `dashboard-public`
- Role assignment หลังยืนยันสำเร็จ
- Repeat verification handling: ถ้ามียศอยู่แล้ว ไม่ให้ซ้ำและไม่ DM ซ้ำ
- Success/failure callback page
- Verification logging และ IP/device/risk summary foundation

### Planned / Work in progress

- Dashboard Public renovation
- Owner Dashboard expansion
- Data deletion / retention controls
- Owner-only sensitive reveal controls
- Security Center / env checker
- Full route guard / crypto / model index audit
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
├── render.yaml                      # Render Blueprint draft for 2-service deployment
├── .env.example                     # ตัวอย่าง environment variables แบบ placeholder
├── .gitignore                       # กัน secrets/generated files
├── README.md                        # คู่มือสำหรับคนและ AI
├── CONTEXT.md                       # บริบทเชิงลึกของโปรเจกต์สำหรับ AI agent
├── AGENTS.md                        # กฎสำหรับ AI coding agent
├── discord/
│   ├── index.js                     # Service 1 boot sequence: Express → MongoDB → Discord
│   ├── commands.js                  # Slash command registry/router
│   ├── commands/verification.js     # Logic ของ /setup-verify
│   ├── index/                       # Service 1 server/view/event/system modules
│   ├── features/
│   ├── sessionManager.js
│   ├── systemProvider.js
│   └── voiceWorker.js
└── dashboard-public/
    ├── package.json                 # Service 2 package, entry point: index.js
    ├── index.js                     # Service 2 Express app
    ├── routes/                      # OAuth/guild/API routes
    ├── models/                      # MongoDB models
    ├── utils/                       # crypto/Discord/IP helpers
    ├── views/                       # HTML views
    └── public/
```

---

## Installation

### Service 1 — Main Bot

```bash
npm install
```

### Service 2 — Dashboard Public

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
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
```

Service 2 ต้องใช้หลัก ๆ:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ENCRYPTION_KEY
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
```

Recommended shared secret for verification state:

```txt
VERIFY_STATE_SECRET
```

Discord Developer Portal OAuth2 Redirect URIs สำหรับ Service 2:

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

ตอนนี้ยังไม่มี automated `npm test`, `lint`, หรือ `build` script

Basic checks:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/verification.js

cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
```

Smoke test สำหรับ verification:

1. ใช้ `/setup-verify` แบบใส่แค่ `channel` และ `role`
2. ใช้ `/setup-verify` พร้อม `button_text: ✅ ยืนยันตัวตน ✅`
3. ตรวจว่า bot ส่ง panel ได้โดยไม่มี `Invalid Form Body`
4. กด verify ด้วยบัญชีปกติ
5. ตรวจว่า OAuth redirect กลับมาที่ Service 2 ถูกต้อง
6. ตรวจว่า role ถูกให้จริง
7. กดซ้ำด้วยบัญชีที่มียศอยู่แล้ว
8. ตรวจว่าไม่มี DM ซ้ำและ role ไม่หาย
9. ตรวจว่า failure page ไม่โชว์ debug details
10. ตรวจ Render logs ว่าไม่มี major runtime errors

---

## Deployment

โปรเจกต์นี้ deploy ได้แบบแยก 2 Render Web Services

### Option A — Manual Render setup

Service 1:

```txt
Root Directory: repository root
Build Command: npm install
Start Command: npm start
```

Service 2:

```txt
Root Directory: dashboard-public
Build Command: npm install
Start Command: npm start
```

### Option B — Render Blueprint

มีไฟล์ `render.yaml` เป็น Blueprint draft สำหรับ 2 services

ก่อนใช้ Blueprint จริงต้องตรวจให้ตรงกับ service names ใน Render Dashboard เพราะถ้า `name` ไม่ตรง Render อาจสร้าง service ใหม่แทนการ update service เดิม

ใน `render.yaml` ไม่ใส่ค่า secret จริง ให้กรอกค่า environment variables ใน Render Dashboard ตาม `.env.example`

---

## Legacy docs status

เอกสารเก่าที่อาจยังเหลือ เช่น `DEPLOYMENT_2_SERVICES.md` และ `RENDER_DEPLOYMENT.md` เป็นข้อมูลช่วยจำรุ่นก่อน ข้อมูลสำคัญถูกย้าย/สรุปไว้ใน `README.md`, `CONTEXT.md`, `.env.example` และ `render.yaml` แล้ว

ถ้า review แล้วไม่มีข้อมูลใหม่เพิ่ม สามารถลบหรือย้ายไป `docs/legacy/` ได้

---

## Safety / Security Notes

- ห้าม commit `.env`
- ห้าม hardcode Discord credentials
- ห้าม log secret, OAuth credential, password, database URL หรือ webhook URL
- ใช้ Discord bot credentials และ OAuth2 scopes แบบโปร่งใสเท่านั้น
- ถ้า secret หลุด ให้ rotate ทันที
- ตรวจ AI-generated code ก่อนรันหรือ deploy เสมอ
- เก็บ raw IP หรือข้อมูลละเอียดอ่อนให้ owner-only และต้องมี audit log
- อย่าเปิด debug details ให้ public user เห็น

---

## Useful Commands

```bash
# Git status
git status --short --untracked-files=all

# ดู diff เฉพาะ docs/config
git diff -- README.md CONTEXT.md AGENTS.md .gitignore .env.example render.yaml package-lock.json .replit

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

ก่อน deploy ให้ตรวจ:

```txt
- ไม่มี .env ถูก track
- ไม่มี secret ใน diff
- validation commands ผ่าน
- smoke test plan พร้อม
- รู้ว่าต้อง redeploy Service 1 หรือ Service 2
```
