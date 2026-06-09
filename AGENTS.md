# AGENTS.md — AI Coding Agent Rules

ไฟล์นี้คือกฎหลักสำหรับ AI coding agents ที่จะทำงานใน repository นี้ เช่น ChatGPT, Codex, Claude, Copilot หรือ automation agent อื่น ๆ

โปรเจกต์นี้มี Discord bot, OAuth2 verification service, dashboards, MongoDB models, environment-sensitive configuration และข้อมูล user/session ที่อ่อนไหว ดังนั้น AI ต้องทำงานแบบระวังสูงสุด

---

## Purpose

เป้าหมายของไฟล์นี้คือ:

- ทำให้ AI เข้าใจขอบเขตก่อนแก้ไฟล์
- ลดการแก้โค้ดผิดส่วน
- ป้องกัน secrets หลุด
- ป้องกันการ rewrite โปรเจกต์โดยไม่จำเป็น
- บังคับให้ AI plan → implement → review → validate อย่างเป็นขั้นตอน

---

## Required Reading Order

ก่อนเริ่มงานทุกครั้ง AI ต้องอ่านตามลำดับนี้:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `README.md`
4. `package.json`
5. `dashboard-public/package.json`
6. ไฟล์ที่เกี่ยวข้องโดยตรงกับ task นั้น ๆ

ห้ามเริ่มแก้ทันทีโดยยังไม่เข้าใจบริบท

---

## Core Rules

กฎหลัก:

- Do not edit files immediately.
- Plan first for complex tasks.
- Ask clarifying questions if the task is ambiguous.
- Keep changes small and focused.
- Do not rewrite unrelated code.
- Do not remove existing features without approval.
- Do not change architecture without approval.
- Do not add dependencies without approval.
- Do not edit `package.json` unless explicitly approved.
- Do not commit, push, or deploy unless explicitly instructed.
- Summarize changes after every edit.
- Provide test/validation commands after code changes.
- Be honest about tests that were not run.

---

## Project Overview

Repository นี้เป็นระบบ **Two-service Discord automation and verification platform**

```txt
Service 1 = Main Discord Bot / Owner System
Service 2 = Dashboard Public / Verification Dashboard
```

Service 1 ดูแล Discord bot, slash commands, owner/admin dashboard routes, voice/session subsystem, audit logging และ verification panel setup

Service 2 ดูแล Discord OAuth2 verification callback, guild-admin dashboard foundation, internal APIs, verification logs, IP/device/risk summaries และ role assignment ผ่าน bot token

อ่านรายละเอียดเพิ่มใน `CONTEXT.md`

---

## Repository Layout

```txt
.
├── package.json
├── README.md
├── CONTEXT.md
├── AGENTS.md
├── .env.example
├── .gitignore
├── discord/
│   ├── index.js
│   ├── commands.js
│   ├── commands/
│   │   └── verification.js
│   ├── index/
│   ├── features/
│   ├── sessionManager.js
│   ├── systemProvider.js
│   └── voiceWorker.js
└── dashboard-public/
    ├── package.json
    ├── index.js
    ├── routes/
    ├── models/
    ├── utils/
    ├── views/
    └── public/
```

Important notes:

- `discord/index.js` คือ Service 1 entry point
- `dashboard-public/index.js` คือ Service 2 entry point
- `discord/commands.js` ควรเป็น command registry/router เท่านั้น
- `discord/commands/verification.js` คือ logic หลักของ `/setup-verify`
- `dashboard-public/routes/oauth.js` เป็น security-sensitive OAuth/verification backend

---

## Setup Commands

### Service 1 — Main Bot

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

### Service 2 — Dashboard Public

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

### Test / lint / build

```txt
No npm test script currently found
No lint script currently found
No build script currently found
```

อย่า invent command ที่ไม่มีจริงใน `package.json`

---

## Validation Commands

เมื่อแก้ JavaScript ฝั่ง Service 1:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/verification.js
```

เมื่อแก้ JavaScript ฝั่ง Service 2:

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
```

เมื่อแก้ docs เท่านั้น:

```bash
git diff -- README.md CONTEXT.md AGENTS.md .gitignore .env.example
```

เมื่อแก้ environment variables:

```bash
git diff -- .env.example README.md CONTEXT.md AGENTS.md
```

ห้าม run deploy เองถ้าไม่ได้รับคำสั่งชัดเจน

---

## Coding Conventions

AI ต้องรักษา style เดิมของโปรเจกต์:

- Follow existing code style.
- Use existing module patterns.
- Use existing naming style.
- Avoid unnecessary abstraction.
- Avoid big rewrites.
- Prefer readable code.
- Keep error handling consistent.
- Do not reformat unrelated files.
- Do not change behavior outside the requested scope.

ถ้าเจอไฟล์ใหญ่หรือหลายระบบปนกัน ให้แก้แบบ surgical change เท่านั้น เว้นแต่เจ้าของโปรเจกต์อนุมัติให้ refactor

---

## Documentation Rules

ต้อง update docs เมื่อมีการเปลี่ยนแปลงเหล่านี้:

- เพิ่ม environment variable ใหม่
- เปลี่ยน command หรือ script
- เปลี่ยน setup/install process
- เปลี่ยน deploy process
- เพิ่มฟีเจอร์ใหญ่
- เปลี่ยน behavior สำคัญ
- เปลี่ยน OAuth scopes
- เพิ่ม dependency

ไฟล์ docs ที่ควรพิจารณา:

```txt
README.md
CONTEXT.md
AGENTS.md
.env.example
```

ห้าม document ฟีเจอร์ที่ไม่มีจริงว่าเสร็จแล้ว ให้แยก `planned`, `work in progress`, `stable` ให้ชัด

---

## Environment and Secrets Rules

กฎนี้สำคัญที่สุด:

- Never read, print, log, expose, or commit real secrets.
- Never modify `.env` directly.
- Never create `.env` with real values.
- Update `.env.example` only with placeholder values.
- If a secret appears in code, docs, logs, screenshot, or diff, stop and warn the user.
- Do not include API keys, tokens, cookies, passwords, database URLs, private keys, webhook URLs, session values, or credentials in commits or docs.

ห้ามใส่ค่าจริงใน:

```txt
README.md
CONTEXT.md
AGENTS.md
.env.example
commit messages
Pull Request bodies
comments
logs
```

ใช้ placeholder เท่านั้น เช่น:

```txt
TOKEN_MANAGER=YOUR_DISCORD_BOT_TOKEN
DISCORD_CLIENT_SECRET=YOUR_DISCORD_CLIENT_SECRET
MONGO_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/database
```

---

## Discord / Bot Safety Rules

เพราะ repo นี้เป็น Discord bot + OAuth2 project ต้องทำตามกฎนี้:

- Use official bot token flow only.
- Do not use Discord user tokens.
- Do not create selfbot behavior.
- Do not collect Discord tokens from users.
- Do not collect passwords, cookies, or credentials.
- Do not log user credentials.
- Do not add phishing-like verification flows.
- Keep OAuth scopes minimal and documented.
- Treat bot token, OAuth client secret, webhook URL, API secret, session secret, and database URL as secrets.
- Do not expand OAuth scopes without explicit approval.
- Do not collect IP addresses or personal data unless clearly necessary, documented, and owner-approved.

Current verification scopes should remain documented and reviewed before changes.

---

## Protected / High-Risk Areas

ห้ามแก้ไฟล์เหล่านี้โดยไม่จำเป็น และต้องขออนุญาตถ้างานไม่ได้ระบุชัด:

```txt
discord/voiceWorker.js
discord/systemProvider.js
discord/sessionManager.js
discord/index.js boot sequence
discord/index/system.js crash/shutdown behavior
discord/index/events.js event routing
dashboard-public/routes/oauth.js callback security logic
dashboard-public/utils/crypto.js
dashboard-public/models/* database schema/indexes
package.json
package-lock.json
render.yaml
.github/workflows/*
```

ถ้าจำเป็นต้องแตะ ให้ทำ plan ก่อนและอธิบาย risk

---

## Git Rules

- Check `git status` before changes.
- Do not commit unless the user explicitly asks.
- Do not push unless the user explicitly asks.
- Do not deploy unless the user explicitly asks.
- If changes are risky, suggest backup branch or tag first.
- Keep commits focused.
- Do not force-push unless explicitly approved.
- After changes, summarize changed files and reasons.

ถ้าแก้ผ่าน GitHub Contents API ต้องแจ้งผู้ใช้ว่า GitHub จะสร้าง commit อัตโนมัติ

---

## Agent Workflow

### Phase 1: Inspect

- Read required docs
- Inspect relevant files
- Identify current state
- Do not edit yet

### Phase 2: Plan

- Explain understanding
- List files to change
- Explain risks
- Ask for confirmation when scope is large or sensitive

### Phase 3: Implement

- Make focused edits only
- Do not touch unrelated files
- Stop if scope expands
- Do not add dependencies unless approved

### Phase 4: Review

- Summarize diff
- Explain why each file changed
- Mention any risk or uncertainty

### Phase 5: Validate

- Run or recommend validation commands
- Report result honestly
- If unable to run, explain exactly what the user should run

### Phase 6: Next Step

- Suggest next safe action
- Wait for approval before commit/push/deploy unless already authorized

---

## Done Definition

งานถือว่าเสร็จเมื่อ:

- Requested feature/docs change is implemented
- No unrelated files changed
- No secrets exposed
- Environment variables are documented if changed
- README/CONTEXT/AGENTS updated if needed
- Validation command is provided
- User can understand what changed and why

---

## When to Stop and Ask

AI ต้องหยุดถามก่อนถ้า:

- Need to change architecture
- Need to add dependency
- Need to change package manager
- Need to edit deployment config
- Need to touch secrets
- Need to remove a feature
- Need to change database schema
- Need to create GitHub Actions
- Need to create or edit `render.yaml`
- Need to change OAuth scopes
- Need to change authentication logic
- Existing code suggests security/privacy risk
- Requirements are unclear

---

## Output Format After Work

หลังทำงาน ให้ตอบตามนี้:

1. Summary
2. Files changed
3. What changed
4. Why changed
5. Safety check
6. How to test / validate
7. Risks / notes
8. Next recommended step

ห้ามอ้างว่าทดสอบแล้วถ้าไม่ได้ทดสอบจริง

---

## Owner Decisions / Do Not Re-Suggest Rules

AI ต้องอ่าน `OWNER_DECISIONS.md` ก่อนเสนอให้ลบ, rewrite, migrate หรือเปลี่ยน architecture ใหญ่ของโปรเจกต์

เจ้าของโปรเจกต์ตัดสินใจแล้วว่าในเฟสนี้:

- ใช้ `discord.js` v13 เป็นฐานหลักก่อน
- คง voice/session subsystem เดิมไว้
- คง dashboard structure เดิมไว้
- คง verification architecture เดิมไว้
- คง owner/admin controls ที่มีอยู่เดิมไว้
- คง one repository + two services + shared MongoDB ไว้

ห้ามเสนอซ้ำโดยไม่มีหลักฐานใหม่:

- migrate เป็น `discord.js` v14 ทันที
- rewrite โปรเจกต์ใหม่ทั้งก้อน
- ลบ voice/session subsystem
- ลบ dashboard เดิมทั้งหมด
- ลบ verification architecture เดิม
- แยก repository ทันที
- เปลี่ยน architecture โดยยังไม่ได้ inspect implementation จริง

ถ้าพบ bug หรือ security issue ให้รายงานแบบมีหลักฐาน:

```txt
File:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Files affected:
Validation:
```

ห้ามใช้คำแนะนำ generic เช่น "ดูแปลก ให้ลบทิ้ง" หรือ "ไม่ใช่ best practice ให้ rewrite ทั้งหมด" โดยยังไม่ได้อ่านไฟล์จริง
