# Render Deployment — 2 Services

ระบบนี้แยกเป็น 2 Render Web Services เพื่อกันข้อมูลเจ้าของบอทหลุดไปยัง Dashboard สำหรับแอดมินเซิร์ฟอื่น

## Service 1 — Main Bot + Owner Dashboard

ใช้สำหรับบอทหลัก, dashboard เจ้าของบอท, ระบบ voice/session และ shadow/admin area

- Root Directory: repository root
- Build Command: `npm install`
- Start Command: `npm start`
- Env หลัก:
  - `TOKEN_MANAGER`
  - `MONGO_URI`
  - `ENCRYPTION_KEY`
  - `API_SECRET`
  - `DASHBOARD_PIN`
  - `DASHBOARD_URL` = URL ของ Service 2
  - `PORT` ให้ Render จัดการได้ หรือปล่อยว่าง

## Service 2 — Dashboard 3 / Public Verification Dashboard

ใช้สำหรับ OAuth2 verification, หน้า admin guild, logs/stats/members ของแต่ละ guild

- Root Directory: `dashboard-public`
- Build Command: `npm install`
- Start Command: `npm start`
- Env หลัก:
  - `MONGO_URI`
  - `TOKEN_MANAGER`
  - `DISCORD_CLIENT_ID`
  - `DISCORD_CLIENT_SECRET`
  - `ENCRYPTION_KEY`
  - `SESSION_SECRET`
  - `DASHBOARD_URL` = URL ของ Service 2 ตัวเอง
  - `INTERNAL_API_SECRET` หรือ `API_SECRET`
  - `NODE_ENV=production`

## Discord Developer Portal

เพิ่ม Redirect URIs ให้ตรงกับ Service 2:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

## Verify URL policy

ระบบนี้ใช้ path:

```txt
/verify?t=...
```

ดังนั้นบอทจะส่งลิงก์ประมาณ:

```txt
${DASHBOARD_URL}/verify?t=STATE_TOKEN
```

อย่าใช้ `/oauth/verify` ถ้าไม่ได้เปลี่ยน route mount เอง

## Notes

- Service 2 ต้องมี `TOKEN_MANAGER` เพราะต้องให้ยศผ่าน Bot token หลัง OAuth2 สำเร็จ
- อย่าเปิดเผย `API_SECRET`, `INTERNAL_API_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`
- ถ้าเปลี่ยน `ENCRYPTION_KEY` token/IP ที่เคยเข้ารหัสไว้จะถอดกลับไม่ได้
- Admin เซิร์ฟอื่นควรเข้าถึงเฉพาะ Service 2 เท่านั้น
- Owner dashboard ใน Service 1 ควรเรียก Service 2 ผ่าน internal API เท่านั้น
