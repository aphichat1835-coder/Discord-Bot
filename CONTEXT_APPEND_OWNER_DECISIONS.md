---

## Owner Decision Context

โปรเจกต์นี้มี `OWNER_DECISIONS.md` เพื่อบันทึกการตัดสินใจที่ AI ไม่ควรแนะนำซ้ำโดยไม่มีหลักฐานใหม่

Current owner decisions:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep current dashboard structure.
Keep current verification architecture.
Keep owner/admin controls.
Keep one repo + two services + shared MongoDB.
```

AI ต้องไม่สรุปว่าระบบใดควรถูกลบเพียงเพราะดูไม่ปกติ ต้อง inspect ก่อนว่า:

```txt
Where is it imported?
Where is it called?
Which route/command/event/dashboard depends on it?
Which MongoDB/config data depends on it?
What breaks if removed?
Did owner explicitly choose to keep it?
```

Security review ยังทำได้ แต่ต้องเป็น concrete review ที่ชี้ file/behavior/impact/fix ไม่ใช่ generic warning ซ้ำ ๆ
