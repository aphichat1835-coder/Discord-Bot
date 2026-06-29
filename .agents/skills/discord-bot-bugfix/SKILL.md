---
name: discord-bot-bugfix
description: Workflow สำหรับแก้บัคใน Discord Bot โปรเจกต์นี้ (phomueangtai-enterprise). ใช้เมื่อมี CI fail, test พัง, dependency ปัญหา, หรือต้องการตรวจสอบโค้ดก่อน push ขึ้น GitHub branch Reee
---

# Discord Bot Bug Fix Workflow

โปรเจกต์: `phomueangtai-enterprise` — Node.js Discord Bot + dashboard-public

GitHub: `https://github.com/aphichat1835-coder/Discord-Bot`  
Branch หลักที่ใช้งาน: `Reee`  
Token secret: `GITHUB_PERSONAL_ACCESS_TOKEN`

---

## ขั้นตอนมาตรฐานเมื่อรับรายงานบัค

### 1. ดึงโค้ดล่าสุดจาก branch Reee
```bash
git fetch origin Reee
git checkout Reee
git pull origin Reee
```

### 2. วิเคราะห์บัค
- อ่าน log / error message ที่ผู้ใช้ส่งมาให้ครบทุกบรรทัด
- ใช้สกิล **diagnostics** (`getLatestLspDiagnostics`) ตรวจ static error หลังแก้ไฟล์
- ใช้สกิล **validation** รัน test/check ก่อน push
- ใช้สกิล **web-search** ถ้าต้องการข้อมูลเพิ่มเติมเกี่ยวกับ package หรือ CI issue

### 3. แก้ไข
- แก้ไฟล์ที่เกี่ยวข้อง
- ตรวจ syntax: `node --check <file>`
- รัน validation ผ่านสกิล **validation**

### 4. ตรวจสอบก่อน push
- ใช้สกิล **diagnostics** ตรวจ LSP errors
- ใช้สกิล **code-review** ให้ architect ตรวจทุกครั้ง
- ถ้า code-review ส่งคืน Fail → แก้ทันทีแล้ว review ซ้ำ

### 5. Push ขึ้น GitHub
```bash
git add <files>
git commit -m "<concise message>"
git push https://$GITHUB_PERSONAL_ACCESS_TOKEN@github.com/aphichat1835-coder/Discord-Bot.git Reee
```
> หมายเหตุ: ใช้ raw git push กับ token ตรงๆ เพราะ `gitPush()` callback มีปัญหากับ remote นี้

---

## กฎ CI ของโปรเจกต์นี้

**ห้ามใช้ flags เหล่านี้** กับ `npm ci` หรือ `npm audit` ใน `.github/workflows/ci.yml`:
- `--omit=optional` — ทำให้ native binding หาย (`@snazzah/davey-linux-x64-gnu`, `@unrs/resolver-binding-linux-x64-gnu`) และทำให้ audit resolve dependency แปลก ๆ
- `--ignore-scripts` — ขัดขวาง postinstall scripts ที่จำเป็น
- `--omit=peer` — ทำให้ Jest 30 พัง

**install ใช้แค่นี้:**
```yml
run: npm ci --no-audit --no-fund
```

**audit ใช้แค่นี้:**
```yml
run: npm audit --audit-level=high
run: npm --prefix dashboard-public audit --audit-level=high
```

**Dashboard verify ที่ถูกต้อง:**
```yml
run: cd dashboard-public && node -e "require.resolve('jest-circus/runner'); require('jest-resolve'); console.log('dashboard jest ok')"
```
> อย่าใช้ `npm exec -- node` เพราะ npm จะพยายาม install `node` เป็น package
> อย่าใช้ deep path `jest-circus/build/runner.js` เพราะเสี่ยงพังเมื่อ Jest เปลี่ยน build structure — ใช้ `jest-circus/runner` แทน

---

## Validation Commands ที่ลงทะเบียนไว้

| ชื่อ | คำสั่ง |
|------|--------|
| `syntax-discord` | `npm run check:all` |
| `syntax-dashboard` | `npm run check:dashboard:all` |
| `memory-guards` | `npm run check:memory-guards` |
| `test-discord` | `find discord/tests -name '*.test.js' ! -name 'voiceWorker*.test.js' -print0 \| xargs -0 -r node --test` |
| `test-voice` | `node --test discord/tests/voiceWorker*.test.js` |

ใช้ผ่านสกิล **validation**: `startValidationRun({ commandIds: ["syntax-discord", "test-discord"] })`

---

## Dependency Chain สำคัญ

```
@discordjs/voice@0.19.2
└─ @snazzah/davey
   └─ optional: @snazzah/davey-linux-x64-gnu  ← ต้องมีบน Linux CI

jest@30
└─ jest-resolve
   └─ unrs-resolver
      └─ optional: @unrs/resolver-binding-linux-x64-gnu  ← ต้องมีบน Linux CI
```

---

## จุดเปราะบางในโปรเจกต์

| ไฟล์ | ปัญหา | วิธีแก้ |
|------|--------|---------|
| `discord/commands/panelInteractions.js` | voiceWorker ใช้ lazy require | เรียกผ่าน `getVoiceWorker()` เสมอ |
| `discord/logging/logCore.js` | `sessionManager.getLogChannelMap` อาจไม่มีใน mock | ใช้ `typeof === "function"` guard |
| `discord/tests/voiceWorker*.test.js` | voice tests ต้องการ native binding | รันแยกผ่าน `test:voice` ไม่ใช่ `test:discord` |
