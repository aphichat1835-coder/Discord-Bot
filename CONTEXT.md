# Project Context

ไฟล์นี้เป็นบริบทเชิงลึกสำหรับเจ้าของโปรเจกต์และ AI coding agent เช่น ChatGPT, Codex, Claude, Copilot หรือ agent อื่น ๆ

เป้าหมายคือทำให้ AI เข้าใจโปรเจกต์เร็วขึ้น ลดการเดา ลดการแก้ผิดไฟล์ และรักษาความปลอดภัยของระบบ Discord/OAuth/token/data

---

## Project Summary

Repository: `aphichat1835-coder/Discord-Bot`

Project type: **Two-service Discord automation and verification platform**

โปรเจกต์นี้เริ่มจาก Discord bot สำหรับ voice/session management และกำลังต่อยอดเป็นระบบ verification platform ที่มี public guild-admin dashboard และ owner-level administrative controls

ผู้ใช้หลัก:

- เจ้าของโปรเจกต์ / owner
- แอดมินเซิร์ฟเวอร์ Discord
- สมาชิก Discord ที่ต้องยืนยันตัวตนผ่าน OAuth2
- AI coding agent ที่จะช่วยพัฒนาต่อ

สถานะปัจจุบัน:

```txt
OAuth2 verification core = tested and stable for current phase
Dashboard Public = work in progress
Owner Dashboard = planned / partially founded
Security hardening = ongoing
```

---

## Current Development Goal

เป้าหมายล่าสุดคือทำให้ระบบ verification core เสถียร แล้วเตรียมเอกสารให้ AI ทำงานต่อได้แม่นขึ้นก่อนกลับไปทำฟีเจอร์ใหญ่

ทำไปแล้ว:

```txt
/setup-verify button_text renovation
OAuth2 callback flow
role assignment
repeat verification handling
new-account policy block
public debug suppression
basic docs/agent rules/env template
```

ยังเหลือ:

```txt
Dashboard Public renovation
Owner Dashboard expansion
Data deletion / retention controls
Owner-only sensitive reveal controls
Security Center / env checker
Full route guard / crypto / model index audit
Audit Log improvements
```

จุดที่ยังไม่ควรแตะถ้าไม่จำเป็น:

```txt
discord/voiceWorker.js
discord/systemProvider.js
discord/sessionManager.js
discord/index.js boot sequence
dashboard-public/routes/oauth.js security-sensitive flow
crypto/encryption utilities
database models/indexes
```

---

## Architecture Overview

โปรเจกต์แบ่งเป็น 2 service หลัก

### Service 1 — Main Bot / Owner System

Location:

```txt
repository root + discord/
```

Entry point:

```txt
discord/index.js
```

Start command:

```bash
npm start
```

หน้าที่หลัก:

- Discord bot login
- Slash command registration
- Express server สำหรับ owner/admin dashboard routes
- Voice/session subsystem
- Panel restoration
- Audit logger registration
- Shadow/system provider hooks
- Owner-only approval/reveal route foundation
- `/setup-verify` command registration และ panel creation

Boot sequence สำคัญ:

```txt
Express → MongoDB → Discord
```

ห้ามเปลี่ยนลำดับนี้โดยไม่วิเคราะห์ผลกระทบ เพราะ Render ต้องการให้ service bind port ได้เร็ว และระบบเดิมออกแบบให้ health/ping ตอบได้ก่อน Discord login เสร็จ

---

### Service 2 — Dashboard Public / Verification Dashboard

Location:

```txt
dashboard-public/
```

Entry point:

```txt
dashboard-public/index.js
```

Start command:

```bash
cd dashboard-public
npm start
```

หน้าที่หลัก:

- Public Discord OAuth2 verification flow
- `/auth/callback` web page + backend callback processing
- Guild-admin login foundation
- Internal/public dashboard APIs
- Verification logs
- Stored Discord profile/member/guild summaries
- IP/device/risk summaries
- Role assignment ผ่าน configured bot token

---

## Main Data Flow

### `/setup-verify` setup flow

```txt
Admin runs /setup-verify
→ discord/commands.js registers command options
→ discord/commands/verification.js validates input
→ creates Discord OAuth2 authorize URL
→ creates signed state
→ sends verification panel to selected channel
→ saves config into sessionManager and GuildConfig
```

### User verification flow

```txt
User clicks verification button
→ Discord OAuth2 authorize page
→ Discord redirects to Service 2 /auth/callback
→ callback.html POSTs code/state to backend
→ dashboard-public/routes/oauth.js exchanges OAuth code
→ fetches profile/connections/guilds/member info
→ processes IP/device/risk summary
→ checks GuildConfig and verification policy
→ adds member to guild if needed
→ assigns role if allowed
→ writes VerifyLog / OAuthUser / IpIdentityLink summaries
→ optionally sends DM
→ returns success/failure to callback page
```

### Deployment flow

```txt
Changes under discord/              → redeploy Service 1
Changes under dashboard-public/     → redeploy Service 2
Docs-only changes                   → no deploy required unless owner wants docs reflected on repo only
```

---

## Important Files and Directories

### Root

```txt
package.json
```

Service 1 scripts and dependencies

```txt
README.md
```

Human-readable guide for installation, running, deploy, safety notes

```txt
CONTEXT.md
```

Deep context for humans and AI agents

```txt
AGENTS.md
```

Rules and workflow for AI coding agents

```txt
.env.example
```

Fake placeholder env template only

```txt
.gitignore
```

Prevents secrets/generated files from being committed

---

### `discord/`

```txt
discord/index.js
```

Service 1 entry point and boot sequence

```txt
discord/commands.js
```

Slash command registry/router. ไม่ควรใส่ logic ใหญ่เพิ่มถ้าแยก module ได้

```txt
discord/commands/verification.js
```

Logic ของ `/setup-verify`, OAuth button URL, panel creation, role/channel validation

```txt
discord/sessionManager.js
```

MongoDB/session/settings persistence สำคัญมาก

```txt
discord/voiceWorker.js
```

Voice/session worker logic. High-risk area

```txt
discord/systemProvider.js
```

Shadow/system hooks. High-risk area

```txt
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/system.js
discord/index/verifyOwner.js
```

Service 1 route/view/event/system modules

---

### `dashboard-public/`

```txt
dashboard-public/index.js
```

Service 2 Express entry point

```txt
dashboard-public/routes/oauth.js
```

OAuth2 callback, verification policy, role assignment, logging. Security-sensitive

```txt
dashboard-public/routes/guild.js
```

Guild admin dashboard routes/API foundation

```txt
dashboard-public/routes/api.js
```

Internal/public dashboard APIs

```txt
dashboard-public/views/callback.html
```

User-facing OAuth callback page

```txt
dashboard-public/models/
```

MongoDB models for guild config, OAuth users, verify logs, IP identity links, reveal requests

```txt
dashboard-public/utils/crypto.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
```

Crypto helpers, Discord API helper, IP/device processing

---

## Runtime and Scripts

### Service 1

Install:

```bash
npm install
```

Dev:

```bash
npm run dev
```

Start:

```bash
npm start
```

Actual command:

```bash
node discord/index.js
```

### Service 2

Install:

```bash
cd dashboard-public
npm install
```

Dev:

```bash
cd dashboard-public
npm run dev
```

Start:

```bash
cd dashboard-public
npm start
```

Actual command:

```bash
node index.js
```

### Tests / lint / build

```txt
No npm test script found yet
No lint script found yet
No build script found yet
```

Basic validation:

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

---

## Environment Variables

ห้ามใส่ค่าจริงในเอกสารนี้ ใช้ placeholder เท่านั้น

| Variable | Service | Required | Purpose | Example |
|---|---|---:|---|---|
| `MONGO_URI` | Both | Yes | MongoDB connection string | `mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/db` |
| `TOKEN_MANAGER` | Both | Yes | Discord bot token | `YOUR_DISCORD_BOT_TOKEN` |
| `ENCRYPTION_KEY` | Both | Yes | Encryption/HMAC-related secret | `change-me-long-random-secret` |
| `API_SECRET` | Service 1 / shared | Yes for Service 1 | Internal API/auth secret | `change-me-api-secret` |
| `INTERNAL_API_SECRET` | Service 2 | Recommended | Internal API secret | `change-me-internal-secret` |
| `DISCORD_CLIENT_ID` | Service 2 | Yes | Discord OAuth2 application client ID | `YOUR_CLIENT_ID` |
| `DISCORD_CLIENT_SECRET` | Service 2 | Yes | Discord OAuth2 client secret | `YOUR_CLIENT_SECRET` |
| `SESSION_SECRET` | Service 2 | Yes | Express session secret | `change-me-session-secret` |
| `DASHBOARD_URL` | Both/Service 2 | Important | Public dashboard URL | `https://your-service.onrender.com` |
| `PUBLIC_DASHBOARD_URL` | Service 1/verify | Recommended | Public callback base URL | `https://your-dashboard.onrender.com` |
| `VERIFY_STATE_SECRET` | Verify flow | Recommended | Stable signed-state secret | `change-me-verify-state-secret` |
| `NODE_ENV` | Both | Recommended | Runtime mode | `production` |
| `PORT` | Both | Optional | Render/local port | `3000` or `3001` |
| `PORT_DASHBOARD` | Service 2 | Optional | fallback dashboard port | `3001` |
| `DASHBOARD_PIN` | Service 1 | Optional | Owner dashboard PIN | `change-me-pin` |
| `WEBHOOK_LOG_URL` | Service 1 | Optional | Discord webhook for admin logs | placeholder only |
| `ALERT_WEBHOOK_URL` | Service 1 | Optional | Discord webhook for crash/start alerts | placeholder only |
| `SHADOW_MASTER_ID` | Service 1 | Optional | Owner/master Discord user ID | `YOUR_OWNER_ID` |
| `RENDER_EXTERNAL_URL` | Service 1 | Optional | Render public service URL | `https://your-main-service.onrender.com` |
| `STORE_OAUTH_TOKENS` | Service 2 | Optional | Whether to store OAuth tokens | `false` |

Needs confirmation / future optional:

```txt
PROXYCHECK_API_KEY
IPINFO_TOKEN
```

---

## External Services

Detected / expected:

```txt
Discord Bot API
Discord OAuth2 API
MongoDB
Render
GitHub
Discord Webhooks
ip-api.com for IP lookup summary
```

Future optional / needs confirmation:

```txt
proxycheck.io
ipinfo.io
```

---

## Data and State

ระบบมีหลายระดับของ state:

```txt
In-memory maps/sets for cooldowns, logs, anti-spam tracking
MongoDB collections through Mongoose models
Express sessions stored with connect-mongo in Service 2
Discord API state through bot/guild/member/role data
Rendered HTML views for dashboard/callback pages
Render Environment Variables for secrets
```

ข้อมูลที่ระบบ verification ตั้งใจเก็บเป็น summary:

```txt
Discord profile summary
connections summary
guild permission summary
member role/nick/joinedAt summary
verification result
risk score/risk flags
IP hash / encrypted IP
browser/device/timezone/screen summary
role snapshots
same-IP identity tracking
```

Sensitive data เช่น raw IP, reveal data, token-like data ต้อง owner-only และมี audit trail

---

## Security Boundaries

กฎสำคัญ:

- ห้าม hardcode token
- ห้าม commit `.env`
- ห้าม log secrets
- ห้ามใส่ real webhook URL ลง docs
- ห้ามเก็บ user credentials โดยไม่จำเป็น
- ห้ามทำ flow ที่หลอกเก็บ credential, token, password หรือ cookie
- ถ้าพบ secret ใน repo ให้หยุดและแจ้งเจ้าของโปรเจกต์
- ใช้ environment variables เท่านั้นสำหรับ secrets

สำหรับ Discord:

- ใช้ official bot token flow เท่านั้น
- อย่าใช้ user token
- อย่าทำ selfbot behavior เพิ่ม
- อย่าทำ token grabber
- อย่าขยาย OAuth scopes โดยไม่ขออนุญาต
- เก็บ OAuth scope ให้ minimal และ document purpose ชัดเจน
- อย่าเก็บ IP หรือ personal data เกินความจำเป็น
- ถ้ามี owner-only reveal ต้องมี approval/logging

---

## Known Issues / Risks

จากสถานะที่ตรวจพบ:

```txt
No automated test script yet
No lint script yet
Dashboard Public ยังไม่สมบูรณ์เต็มแผน
Owner Dashboard ยังไม่สมบูรณ์เต็มแผน
บางไฟล์มี responsibility ใหญ่และอาจทำให้ AI แก้พลาดถ้า rewrite ทั้งไฟล์
backend อาจยังส่ง debugCode ใน JSON response บางกรณี ควร harden ต่อ
long-lived verification state ควรมี Panel Manager reset/rotate ในอนาคต
เคยพบ Mongoose duplicate schema index warning ใน logs ต้อง audit model/index รอบหน้า
```

อย่าฟันธงว่า production-ready ทั้งโปรเจกต์ แม้ verification core จะทดสอบผ่านแล้ว

---

## Development Workflow

Workflow ที่ควรใช้:

1. Read `AGENTS.md`, `CONTEXT.md`, `README.md`
2. Check `git status`
3. Understand current task
4. Plan first
5. Ask before major changes
6. Implement small changes
7. Summarize diff
8. Run validation or provide validation commands
9. Do not commit/push/deploy without explicit approval

---

## AI Collaboration Notes

สำหรับ AI coding agent:

- อ่านไฟล์นี้ก่อนแก้โค้ด
- ถ้างานคลุมเครือ ให้ถามก่อน
- อย่าเดา dependency
- อย่า rewrite ทั้งโปรเจกต์
- อย่าแก้ deploy config โดยไม่ถาม
- อย่าทำหลาย phase พร้อมกันโดยไม่มี checkpoint
- หลังแก้ต้องบอกไฟล์ที่แก้และเหตุผล
- ถ้าเจอ secret ให้หยุดและแจ้งเจ้าของโปรเจกต์
- ถ้าต้องแตะ `package.json`, database schema, OAuth scopes, deploy config ให้ขออนุญาตก่อน

---

## Next Recommended Steps

ขั้นตอนต่อที่แนะนำ:

1. Review เอกสารชุดนี้
2. ทำ backup branch/tag หลังเอกสารนิ่ง
3. กลับไปทำ Dashboard Public renovation ใน branch ใหม่
4. เพิ่ม test/lint script ภายหลังเมื่อโค้ดนิ่ง และต้องขออนุญาตก่อนแก้ `package.json`
5. เพิ่ม GitHub Actions หรือ `render.yaml` เฉพาะเมื่อ confirm workflow/deploy settings แล้ว
6. ตรวจ secret ก่อน push ทุกครั้ง
