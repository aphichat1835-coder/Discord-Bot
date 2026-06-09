---

## Owner Decisions / Architecture Notes

อ่านรายละเอียดเต็มใน `OWNER_DECISIONS.md`

สรุปสั้น:

```txt
This project intentionally keeps discord.js v13 for now.
This project intentionally keeps the current voice/session subsystem.
This project intentionally keeps the current dashboard and verification architecture.
This project intentionally uses one repository, two services, and shared MongoDB.
```

AI/coding agent ไม่ควรเสนอ migration, rewrite, removal หรือ architecture replacement ซ้ำ ๆ โดยยังไม่ได้อ่าน implementation จริง

ถ้าจะเสนอการเปลี่ยนใหญ่ ต้องอ้างอิงจาก:

- ไฟล์ที่ตรวจแล้ว
- behavior ที่พบจริง
- impact ที่ชัดเจน
- minimal fix ที่ไม่ลบระบบเดิมโดยไม่จำเป็น
