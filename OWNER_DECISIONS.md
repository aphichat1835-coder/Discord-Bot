# OWNER_DECISIONS.md

ไฟล์นี้บันทึกการตัดสินใจของเจ้าของโปรเจกต์ เพื่อให้ AI coding agents เข้าใจบริบทก่อนรีวิวหรือแก้โค้ด

## Owner Decisions

เจ้าของโปรเจกต์เข้าใจโครงสร้างของระบบนี้แล้ว และตั้งใจคงระบบหลักต่อไปนี้ไว้:

- ใช้ `discord.js` v13 เป็นฐานหลักในตอนนี้
- คง voice/session subsystem เดิมไว้
- คง dashboard structure เดิมไว้
- คง verification architecture เดิมไว้
- คง owner/admin controls ที่มีอยู่เดิมไว้
- คงการออกแบบแบบ one repository + two services + shared MongoDB ไว้

AI ไม่ควรเสนอให้ลบ ย้าย หรือ rewrite ระบบเหล่านี้ซ้ำ ๆ เว้นแต่พบ bug จริง, security issue ที่อธิบายได้ชัดเจน, หรือเจ้าของโปรเจกต์สั่งให้แก้โดยตรง

## Architecture Decisions

โปรเจกต์นี้ตั้งใจออกแบบเป็น:

```txt
one repository
two services
shared MongoDB
shared Discord application/bot identity
separate Express apps
```

Service 1:

```txt
discord/index.js
```

ดูแล Discord bot, commands, voice/session, dashboard main, audit, events และระบบ owner/admin ที่เกี่ยวข้อง

Service 2:

```txt
dashboard-public/index.js
```

ดูแล OAuth verification, guild admin dashboard, internal APIs และ verification logs

การที่ทั้งสอง service อ่านข้อมูลร่วมกันจาก MongoDB ไม่ใช่บัค แต่เป็นการออกแบบให้ service แยก runtime และใช้ฐานข้อมูลกลางร่วมกัน

## Previously Rejected Suggestions

AI ไม่ควรเสนอเรื่องเหล่านี้ซ้ำในการรีวิวทั่วไป:

- เปลี่ยนจาก `discord.js` v13 ไป v14 ทันที
- rewrite โปรเจกต์ใหม่ทั้งก้อน
- ลบ voice/session subsystem
- ลบ dashboard structure เดิม
- ลบ verification architecture เดิม
- แยก repository ออกจากกันทันที
- เปลี่ยน architecture โดยยังไม่ได้อ่าน implementation จริง

ถ้าจะเสนอเรื่องเหล่านี้ ต้องมีเหตุผลจากโค้ดจริง ไม่ใช่เดาจากชื่อไฟล์หรือ best practice ทั่วไป

## Known Intentional Design Choices

บางระบบในโปรเจกต์นี้อาจดูไม่ปกติสำหรับ AI บางเจ้า แต่เป็นสิ่งที่เจ้าของโปรเจกต์ตั้งใจคงไว้

ก่อนเสนอให้ลบหรือเปลี่ยน AI ต้องตรวจว่า:

- ระบบนั้นถูก import/use ที่ไหน
- มี route, command, event หรือ dashboard ส่วนไหนพึ่งพามันอยู่
- มีข้อมูลใน MongoDB หรือ config ที่ผูกกับระบบนั้นหรือไม่
- การลบจะทำให้ระบบอื่นพังหรือไม่
- เจ้าของโปรเจกต์เคยบอกให้คงระบบนี้ไว้หรือไม่

## Do Not Re-Suggest List

ห้ามแนะนำซ้ำโดยไม่มีหลักฐานใหม่:

- “ควร migrate เป็น discord.js v14”
- “ควรลบ voice/session subsystem”
- “ควร rewrite dashboard ใหม่ทั้งหมด”
- “ควรแยก service เป็นคนละ repository”
- “ควรลบระบบที่ AI ยังไม่ได้อ่าน implementation”
- “ควรเปลี่ยน architecture ก่อน ทั้งที่ยังไม่ได้ inspect โค้ดจริง”

แนวทางที่ถูกต้องคือ:

```txt
อ่านไฟล์จริงก่อน
→ อธิบายสิ่งที่พบ
→ เสนอเฉพาะจุดที่มีผลต่อ bug, maintainability, runtime หรือ owner request จริง
```

## Security Review Style

AI ยังสามารถรายงาน bug หรือ security issue ได้ แต่ต้องรายงานแบบมีหลักฐานและไม่พูดซ้ำแบบ generic

รูปแบบที่ควรใช้:

```txt
File:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Files affected:
Validation:
```

รูปแบบที่ไม่ควรใช้:

```txt
This looks unusual, remove it.
This is not best practice, rewrite everything.
This project should migrate versions immediately.
I have not inspected the implementation but recommend deleting the subsystem.
```

## Agent Instruction

ก่อนแนะนำการเปลี่ยน architecture หรือการลบระบบใด ๆ ให้ AI อ่านไฟล์เหล่านี้ก่อน:

```txt
AGENTS.md
CONTEXT.md
README.md
OWNER_DECISIONS.md
TASK.md
CODEX_HANDOFF.md
package.json
dashboard-public/package.json
```

หลังจากนั้นให้ inspect ไฟล์ implementation ที่เกี่ยวข้องจริง แล้วค่อยเสนอแผนแบบเฉพาะจุด
