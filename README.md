# Discord Bot - Enterprise Voice Management System

## 📋 About

**Enterprise Voice Management System** - Advanced Discord bot for managing voice channels with user authentication, session management, and real-time monitoring.

### Key Features
- 🎤 Voice channel automation & management
- 👥 Multi-session support (up to 20 concurrent)
- 🔐 Token encryption & security
- 📊 Real-time dashboard monitoring
- ⚡ Express REST API
- 🔄 Auto-reconnection with exponential backoff
- 💾 Persistent session storage
- 📡 Health monitoring & alerts

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Discord Bot Token
- A Discord server

### Installation

```bash
# 1. Clone repository
git clone https://github.com/aphichat1835-coder/Discord-Bot.git
cd Discord-Bot

# 2. Install dependencies
npm install

# 3. Set environment variables
export TOKEN_MANAGER=your_bot_token
export ENCRYPTION_KEY=your_32_char_secret_key

# 4. Start bot
npm start
```

### Configuration

Edit `discord/config.json`:
```json
{
  "roles": {
    "admin": "role_id_here",
    "user": "role_id_here"
  },
  "limits": {
    "maxSessions": 20,
    "rateLimitRequests": 5,
    "rateLimitWindowMs": 60000
  }
}
```

## 📱 Commands

### Admin Commands
- `/panel` - Show control panel
- `/stats` - View system statistics
- `/help` - Display help pages
- `/serverinfo` - Server information
- `/userinfo [@member]` - User profile
- `/setup-log` - Create log channel

### Moderation
- `/kick @member [reason]` - Kick member
- `/ban @member [reason]` - Ban member
- `/unban <user_id>` - Unban user
- `/timeout @member <minutes> [reason]` - Timeout member

### Channel Management
- `/lock` - Lock current channel
- `/unlock` - Unlock current channel
- `/clear <1-100>` - Clear messages
- `/say <message>` - Send message
- `/announce <message>` - Send announcement

## 🎨 Dashboard

Access the web dashboard at:
```
http://localhost:3000
```

Shows:
- ✅ Bot status
- 📊 Active sessions
- 🔗 Server connections
- ⏱️ Uptime & metrics

## 🌐 Deployment

### Render.com Deployment

See [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) for detailed setup guide.

**Quick Steps:**
1. Push code to GitHub
2. Create new Web Service on Render
3. Set environment variables
4. Deploy!

```bash
# Build command
npm install

# Start command
npm start
```

## 📊 Architecture

```
discord/
├── index.js              # Main bot & Express server
├── voiceWorker.js        # Voice connection management
├── sessionManager.js     # Session & database handling
├── commands.js           # Command handlers
└── config.json           # Configuration
```

### System Design
- **Multi-Client Pool**: Efficient token management
- **Session Locking**: Race condition prevention
- **Atomic Saves**: Database integrity
- **Health Monitoring**: 30-second health checks
- **Auto Backup**: Hourly database backups (24 kept)

## 🔐 Security

- ✅ AES-256 token encryption
- ✅ WeakMap for token storage
- ✅ Input validation on all commands
- ✅ Rate limiting per user
- ✅ Secure environment variable handling

## 📈 Monitoring

### UptimeRobot Integration

```
Monitor URL: https://your-service.onrender.com/ping
Interval: 5 minutes
Alerts: Email on downtime
```

### Health Check

```bash
# Check bot status
curl https://your-service.onrender.com/health
```

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot won't start | Check `TOKEN_MANAGER` env var |
| Commands not showing | Wait 10 seconds or restart bot |
| Voice connection fails | Verify voice channel ID format (17-19 digits) |
| Rate limit exceeded | Wait 1 minute, or adjust `rateLimitWindowMs` |
| Render service spinning down | Setup UptimeRobot health monitor |

## 📝 Environment Variables

```bash
TOKEN_MANAGER          # Discord bot token (REQUIRED)
ENCRYPTION_KEY         # 32+ char secret key (REQUIRED in production)
WEBHOOK_LOG_URL        # Discord webhook for logging (optional)
ALERT_WEBHOOK_URL      # Discord webhook for alerts (optional)
NODE_ENV              # Set to 'production' for Render
PORT                  # Server port (default: 3000)
```

## 🔄 Auto-Deployment

Whenever you push to GitHub:
1. Render detects commit
2. Runs `npm install`
3. Runs `npm start`
4. Bot goes live (usually 1-2 min)

## 📖 Documentation

- [Render Deployment](./RENDER_DEPLOYMENT.md) - Complete deployment guide
- [Discord.js](https://discord.js.org) - Bot framework docs
- [Render Docs](https://render.com/docs) - Hosting platform docs

## 🤝 Contributing

Found a bug? Have suggestions?
1. Fork repository
2. Create feature branch
3. Submit pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

- 📧 Email: support@example.com
- 💬 Discord: [Server Link]
- 🐛 Issues: GitHub Issues

---

**Version**: 4.0  
**Last Updated**: 2026-05-15  
**Status**: Production Ready ✅

Made with ❤️ for Discord automation
