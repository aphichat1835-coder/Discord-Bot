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

ห้ามใช้คำแนะนำ generic เช่น “ดูแปลก ให้ลบทิ้ง” หรือ “ไม่ใช่ best practice ให้ rewrite ทั้งหมด” โดยยังไม่ได้อ่านไฟล์จริง
