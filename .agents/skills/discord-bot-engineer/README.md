# Discord Bot Engineer (Skill)

[![Skill: discord-bot-engineer](https://img.shields.io/badge/AI%20Skill-discord--bot--engineer-5865F2?logo=discord&logoColor=white)](SKILL.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python: 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](scripts/)

AI Skill สำหรับวิศวกรพัฒนา Discord Bot และ Discord Applications ครอบคลุมทั้ง JavaScript/TypeScript (Discord.js) และ Python (Discord.py) พร้อมเครื่องมือวิเคราะห์ สถาปัตยกรรม SDLC ระบบความปลอดภัย และชุดตรวจสอบความถูกต้อง (Verification Gates)

---

## 🌟 จุดเด่นและความสามารถ (Capabilities)

- **Interaction & Components V2**: จัดการ Application Commands, Modal, Buttons, Select Menus, และ State Lifecycle อย่างถูกต้อง
- **Modern Discord Features**: รองรับ User-Installable Apps (`contexts: [0, 1, 2]`), Discord Activities (Embedded App SDK), และ AutoMod v2
- **Domain Invariants**: ออกแบบและตรวจสอบระบบ Moderation, Verification, Tickets, Economy (Ledger/Transactions), Voice/Music, และ OAuth Dashboard
- **Thai & Multi-language Support**: มี Locale Catalog ภาษาไทยและอังกฤษ ([`assets/locales/`](assets/locales/)) พร้อมระบบตรวจสอบความสอดคล้อง
- **Security & Authorization**: ตรวจสอบสิทธิ์การใช้งาน (Permissions, Scopes, Intents), ป้องกัน Race Conditions, Replay Attacks, และการรั่วไหลของ Tokens
- **Evidence-Oriented SDLC**: วางแผนการพัฒนา แก้ไขจุดบกพร่องที่ต้นตอ (Root Cause Analysis) และทดสอบก่อนเคลมว่า "เสร็จสมบูรณ์" ด้วยระบบ Gate
- **Starter Templates**: มีแม่แบบบอทสำเร็จรูปทั้ง TypeScript (Discord.js) และ Python (Discord.py) พร้อม Docker
- **CLI Tooling Included**: มีชุดคำสั่ง `discord_engineer.py` สำหรับช่วย AI ประเมินงบประมาณบริบท (Token Budget), ตรวจสอบโค้ด, และจำลองสถานการณ์

---

## 🛠️ โครงสร้างเริ่มต้น (Starter Templates)

โปรเจกต์นี้มี Starter Templates สำเร็จรูปที่เขียนตามหลักสถาปัตยกรรมของ Skill นี้โดยตรง:

- [`templates/discordjs-starter/`](templates/discordjs-starter/) — Discord.js v14+ (TypeScript, ES Modules, User App slash command, Docker)
- [`templates/discordpy-starter/`](templates/discordpy-starter/) — Discord.py 2.4+ (Python 3.11+, Cogs, User App slash command, Error handler, Docker)

---

## 📦 วิธีการติดตั้ง (Installation Guide)

คุณสามารถนำ Skill นี้ไปติดตั้งในโปรเจกต์อื่น หรือติดตั้งในระดับ Global เพื่อให้ AI คู่หูของคุณเรียกใช้งานได้ทันที:

### 1. ติดตั้งสำหรับ Antigravity / Gemini CLI

#### ก. ติดตั้งเฉพาะโปรเจกต์ (Workspace-level)
เข้าไปที่โฟลเดอร์โปรเจกต์ Discord Bot ของคุณ แล้วรันคำสั่ง:

```bash
mkdir -p .agents/skills
git clone https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer.git .agents/skills/discord-bot-engineer
```

*(หรือเพิ่มเป็น Git Submodule)*
```bash
git submodule add https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer.git .agents/skills/discord-bot-engineer
```

#### ข. ติดตั้งแบบ Global (ใช้งานได้กับทุกโปรเจกต์ในเครื่อง)
```bash
mkdir -p ~/.gemini/config/skills
git clone https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer.git ~/.gemini/config/skills/discord-bot-engineer
```

---

### 2. ติดตั้งสำหรับ Claude Code / Cursor / Windsurf

#### Claude Code (Global Skills)
```bash
mkdir -p ~/.claude/skills
git clone https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer.git ~/.claude/skills/discord-bot-engineer
```

#### Cursor / Windsurf / Copilot
สามารถคัดลอกไฟล์ [`SKILL.md`](SKILL.md) หรืออ้างอิงเนื้อหาไปไว้ที่ `.cursorrules` หรือไฟล์ Rules ประจำโปรเจกต์ของคุณ

---

### 3. ติดตั้งสำหรับ OpenAI Agents / ChatGPT / Codex
โปรเจกต์นี้มาพร้อมกับการกำหนดค่า [Agent Interface](agents/openai.yaml):
- ตรวจสอบไฟล์ [`agents/openai.yaml`](agents/openai.yaml)
- ใช้นำเข้าเป็น Custom GPT Action หรือ Agent Policy

---

## 🌐 ระบบภาษาและการแปล (Localization)

โปรเจกต์มีแค็ตตาล็อกข้อความตอบกลับและ Error messages รองรับสองภาษา (อังกฤษและไทย):
- [`assets/locales/en.json`](assets/locales/en.json)
- [`assets/locales/th.json`](assets/locales/th.json)

สามารถตรวจสอบความถูกต้องของ Placeholder และความสมบูรณ์ของการแปลได้ด้วยคำสั่ง:
```bash
python3 scripts/audit_locale_catalogs.py assets/locales/en.json assets/locales/th.json --strict
```

---

## ⚡ ระบบจัดการ Token และ OAuth2 ประสิทธิภาพสูง (Token & OAuth2 Engine)

โปรเจกต์นี้มีชุดโมดูลและเอกสารคู่มือเจาะลึกสำหรับการดึงข้อมูล ตรวจสอบ Token และจัดการล็อกอินหลายบอทอย่างมีประสิทธิภาพสูงสุด:

- **คู่มือเชิงลึกระดับ Protocol:** [`references/token-architecture-and-oauth.md`](references/token-architecture-and-oauth.md) — สอนการดึงข้อมูลตรงผ่าน REST API, โครงสร้าง Header, การแลกเปลี่ยน OAuth2 Access/Refresh Token, และการคำนวณ Rate Limit (429) แบบละเอียด
- **โมดูลสำเร็จรูป (Python):** [`assets/patterns/token_manager.py`](assets/patterns/token_manager.py) — รองรับ Token Pool หมุนเวียนคิว, Direct REST Validator, และ Multi-Bot Orchestration
- **โมดูลสำเร็จรูป (TypeScript/Node.js):** [`assets/patterns/token-manager.mjs`](assets/patterns/token-manager.mjs) — เขียนด้วย ESM Fetch ประสิทธิภาพสูง พร้อมใช้งานในโปรเจกต์ Node.js / Bun

---

## 🚀 การทดสอบและใช้งานเครื่องมือ (CLI & Self-Test)

ภายในโปรเจกต์มีชุดเครื่องมือ CLI สำหรับช่วยตรวจสอบความสมบูรณ์:

### ตรวจสอบความพร้อมของระบบ
```bash
python3 scripts/self_test_tooling.py
```
*(ควรแสดงผล: `skill tooling self-test: PASS`)*

### เรียกดูคำสั่งของ discord_engineer CLI
```bash
python3 scripts/discord_engineer.py --help
```

ตัวอย่างการคำนวณ Context Budget และ Route ก่อนเริ่มงาน:
```bash
python3 scripts/discord_engineer.py budget "สร้างระบบ ticket interaction" --root /path/to/your/bot
python3 scripts/discord_engineer.py route "สร้างระบบ ticket interaction" --root /path/to/your/bot
```

---

## 📁 โครงสร้างโปรเจกต์ (Repository Structure)

```text
.
├── SKILL.md              # แกนหลักของคำแนะนำและข้อกำหนดการทำงานของ AI
├── agents/               # การตั้งค่าสำหรับ OpenAI / ChatGPT / Codex
├── assets/
│   ├── evals/            # ชุดทดสอบ Benchmark และ Scenario สำหรับประเมินความแม่นยำ
│   ├── examples/         # ตัวอย่างโค้ดมาตรฐาน (Discord.js & Discord.py)
│   ├── locales/          # แค็ตตาล็อกภาษา en.json และ th.json สำหรับบอท
│   ├── manifests/        # Token budgets, UX surfaces, และ Security profiles
│   ├── patterns/         # แม่แบบ Pattern สำคัญ เช่น Token Manager และ Progress Reporter
│   └── schemas/          # JSON Schemas สำหรับ Contract และ Verification
├── references/           # เอกสารอ้างอิงเชิงลึก (Kernel, UX, Token Architecture, Modern Discord)
├── scripts/              # เครื่องมือ CLI และ Analysis Libs
└── templates/            # Boilerplates สำเร็จรูป (TypeScript & Python)
```

---

## 📄 ใบอนุญาต (License)

โปรเจกต์นี้เผยแพร่ภายใต้ [MIT License](LICENSE)