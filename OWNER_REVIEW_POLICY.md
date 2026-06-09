# OWNER_REVIEW_POLICY.md

ไฟล์นี้บันทึก policy สำหรับ AI coding agents ที่ช่วยรีวิวหรือแก้โปรเจกต์นี้

## Owner-aware areas

เจ้าของโปรเจกต์รับรู้และตั้งใจคงระบบต่อไปนี้ไว้ใน architecture ปัจจุบัน:

- `discord.js` v13 เป็นฐานหลักของบอทตอนนี้
- voice/session subsystem ปัจจุบัน
- dashboard structure ปัจจุบัน
- verification architecture ปัจจุบัน
- owner/admin controls ปัจจุบัน
- one repository + two services + shared MongoDB
- endpoint หรือ route ที่เกี่ยวกับ owner-only sensitive reveal controls
- IP/device/risk summary ที่ใช้กับ verification และ dashboard policy
- owner/system provider hooks ที่มีอยู่ในโปรเจกต์

AI ไม่ควรเสนอให้ลบหรือ rewrite ระบบเหล่านี้ซ้ำ ๆ ถ้ายังไม่ได้ inspect implementation จริง

## Review style

AI ยังสามารถรายงาน bug, runtime issue, privacy issue หรือ security issue ได้ แต่ต้องรายงานแบบมีหลักฐานจากโค้ดจริง ไม่ใช่ generic warning ซ้ำ ๆ

รูปแบบที่ควรใช้:

```txt
File:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Validation:
```

## Do not re-suggest without new evidence

ห้ามเสนอซ้ำโดยไม่มีหลักฐานใหม่:

- migrate เป็น discord.js v14 ทันที
- rewrite โปรเจกต์ใหม่ทั้งหมด
- ลบ voice/session subsystem
- ลบ dashboard structure เดิม
- ลบ verification architecture เดิม
- ลบ owner/admin controls ที่ยังถูกใช้งาน
- แยก repository ทันที
- เปลี่ยน architecture โดยยังไม่ได้อ่าน implementation จริง

แนวทางที่ถูกต้องคืออ่านไฟล์จริงก่อน แล้วเสนอเฉพาะ minimal fix ที่จำเป็น
