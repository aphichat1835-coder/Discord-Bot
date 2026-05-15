# 🚀 Render Deployment Guide

## ✅ Checklist ก่อน Deploy

### GitHub Preparation
- [ ] Code pushed to GitHub repository
- [ ] `.gitignore` ตั้งค่าแล้ว (ไม่เก็บ token, node_modules)
- [ ] Repository is public (หรือ grant Render access)

### Bot Setup
- [ ] Discord Bot Token ได้แล้ว
- [ ] Bot มี Admin permissions (หรือ specific permissions)
- [ ] Slash commands พร้อม

### Environment Variables
- [ ] `TOKEN_MANAGER` - Discord bot token
- [ ] `ENCRYPTION_KEY` - 32+ character secret key

## 📝 Step-by-Step Setup

### 1. Prepare Discord Bot

```
1. Go to https://discord.com/developers/applications
2. Create New Application
3. Copy TOKEN (ไปใส่ TOKEN_MANAGER)
4. OAuth2 → URL Generator
   - Scopes: bot, applications.commands
   - Permissions: Administrator
5. Copy URL → ไปใส่ใน server
```

### 2. Create Encryption Key

Generate 32+ character random key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Push to GitHub

```bash
# ใน Replit หรือ local
git add .
git commit -m "chore: prepare for Render deployment"
git push origin main
```

### 4. Create Render Account

```
1. Go to https://render.com
2. Sign up with GitHub
3. Grant Render access to repositories
```

### 5. Create Web Service

```
Dashboard → + New → Web Service

Repository:     discord-bot-repo (เลือก repo)
Name:           discord-bot-manager
Environment:    Node
Build Command:  npm install
Start Command:  npm start
Plan:           Free
Region:         Singapore (หรือใกล้ที่สุด)
```

### 6. Set Environment Variables

```
Dashboard → Settings → Environment Variables

TOKEN_MANAGER       → your_discord_bot_token
ENCRYPTION_KEY      → your_generated_encryption_key
NODE_ENV           → production
PORT               → 3000
WEBHOOK_LOG_URL    → (optional) your_webhook_url
```

### 7. Deploy

```
Deploy button → ✅ wait for deployment
```

## 🔗 Setup UptimeRobot (เพื่อไม่ให้ bot sleep)

```
1. Go to https://uptimerobot.com
2. Sign up (free)
3. + Create Monitor
4. Monitor Type: HTTP(s)
5. URL: https://YOUR-SERVICE.onrender.com/ping
6. Interval: 5 minutes
7. Create Monitor
```

## 📊 Verify Deployment

### ✅ Success Signs
```
1. Render dashboard shows "Live"
2. Visit https://YOUR-SERVICE.onrender.com → dashboard loads
3. Bot appears online in Discord server
4. Slash commands work
5. Voice sessions can start
```

### ❌ Troubleshooting

| Error | Solution |
|-------|----------|
| Build failed | Check npm dependencies, ensure package-lock.json |
| Bot offline | Check TOKEN_MANAGER env var |
| Commands not showing | Register commands: `/help` or bot restart |
| Voice won't join | IP might be blocked, wait 1-2 minutes or restart |
| Render spins down | Setup UptimeRobot (see above) |

## 🎯 First Time Usage

```bash
# 1. Bot starts automatically after deploy
# 2. Visit dashboard: https://your-service.onrender.com
# 3. In Discord, type /panel
# 4. Click [⚡ เริ่มเซสชัน]
# 5. Fill in token, server ID, voice channel ID
# 6. Bot joins voice channel! 🎉
```

## 🔄 Updating Code

```bash
# Make changes in Replit
# Commit and push
git push origin main

# Render auto-deploys! 
# (usually within 1-2 minutes)
```

## 📈 Monitoring

### Dashboard
- URL: `https://YOUR-SERVICE.onrender.com`
- Shows: active sessions, uptime, stats

### Logs
- Render Dashboard → Logs tab
- Shows: bot status, errors, connections

### Health Check
- URL: `https://YOUR-SERVICE.onrender.com/health`
- Returns: `{"status": "online", "uptime": "1h 25m"}`

## 🆘 Support & Debugging

### Enable Logging
Bot logs to:
1. **Render Logs** (console output)
2. **Webhook** (if `WEBHOOK_LOG_URL` set)
3. **Discord Channel** (fallback)

### Common Issues & Fixes

**Issue**: "Cannot connect to voice channel"
```
✅ Solution:
- Check voice channel ID (17-19 digits)
- Wait 30 seconds and try again
- Check bot has voice permissions
```

**Issue**: "Bot says offline"
```
✅ Solution:
- Check TOKEN_MANAGER is correct
- Check Node version is 18+
- Restart service from Render dashboard
```

**Issue**: "Rate limit exceeded"
```
✅ Solution:
- Wait 1 minute
- Rate limiter resets automatically
- Contact server admin if persistent
```

## 🎓 Learning Resources

- **Discord.js Docs**: https://discord.js.org
- **Render Docs**: https://render.com/docs
- **Node.js Docs**: https://nodejs.org/docs

## 🚀 Next Steps (Optional)

- [ ] Setup custom domain on Render
- [ ] Enable auto-scaling for larger loads
- [ ] Add more moderation commands
- [ ] Setup analytics dashboard
- [ ] Implement database for persistence

---

**Deployment Date**: [Auto-filled]
**Version**: 4.0
**Status**: Production Ready ✅
