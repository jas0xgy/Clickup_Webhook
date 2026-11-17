# Quick Reference Card

## 🚀 Start Here (Copy & Paste Commands)

### Installation
```bash
cd C:\Users\g8r34\Desktop\clickup-webhook-service
npm install
```

### Running the Service

**Development (with auto-reload):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

### Health Check
```bash
curl http://localhost:3000/health
```

## 🔑 Configuration Checklist

Before running, ensure you have:

- [ ] ClickUp API Token in `.env` as `CLICKUP_API_TOKEN`
- [ ] ClickUp Webhook Secret in `.env` as `CLICKUP_WEBHOOK_SECRET`
- [ ] Port configured in `.env` (default: 3000)
- [ ] NODE_ENV set to "development" (local) or "production"

## 📋 Environment Variables

```env
# Your ClickUp credentials
CLICKUP_API_TOKEN=your_api_token_here
CLICKUP_WEBHOOK_SECRET=your_webhook_secret_here

# Server configuration
PORT=3000
NODE_ENV=development
```

## 🔗 Important URLs

| Purpose | URL |
|---------|-----|
| ClickUp API Docs | https://clickup.com/api |
| ClickUp Settings | https://app.clickup.com/settings/developer |
| ClickUp Webhooks | https://app.clickup.com/settings/integrations |
| Health Check | http://localhost:3000/health |
| Webhook Endpoint | http://localhost:3000/webhook/clickup |

## 📊 ClickUp Events Handled

✅ **taskUpdated** - Triggered when task details change (including custom fields)
✅ **taskStatusUpdated** - Triggered when task status changes
✅ **taskCommentAdded** - Triggered when someone comments
✅ **listUpdated** - Triggered when list details change

## 🎯 Current Logic

```
IF: Custom field on task is marked as "completed" or "true"
THEN: Update task status to "completed"
```

## 🛠️ Common Customizations

### Change the Status It Updates To
**File:** `src/services/webhookHandler.js` (line ~54)
```javascript
// Change from:
await clickup.updateTaskStatus(taskId, 'completed');

// To your preferred status:
await clickup.updateTaskStatus(taskId, 'in progress');
```

### Watch Only Specific Fields
**File:** `src/services/webhookHandler.js` (line ~50)
```javascript
if (fieldName === 'Review' || fieldName === 'Approval') {
  // Only trigger for these fields
}
```

### Add Logging to File
**File:** `src/utils/logger.js`
```javascript
const fs = require('fs');
// Add file logging to info/error methods
```

## 🧪 Testing

### Manual Webhook Test (curl)
```bash
curl -X POST http://localhost:3000/webhook/clickup \
  -H "Content-Type: application/json" \
  -d '{
    "event": "taskUpdated",
    "task_id": "test123",
    "webhook_data": {
      "changes": [{
        "field": "custom_field",
        "name": "Review",
        "after": true
      }]
    }
  }'
```

### Expected Response
```json
{
  "success": true,
  "message": "Webhook received"
}
```

## 🔍 Debugging Tips

### Enable Debug Logging
In `.env`, temporarily change:
```env
NODE_ENV=development
```

### Check Service is Running
```bash
curl http://localhost:3000/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "2024-11-17T13:15:29.099-05:00"
}
```

### View Full Webhook Payload
Add to `src/routes/webhook.js`:
```javascript
console.log('Full payload:', JSON.stringify(req.body, null, 2));
```

### Check API Token
```bash
curl -H "Authorization: YOUR_TOKEN" https://api.clickup.com/api/v2/user
```

Should return user info (not an error).

## 🚨 Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| "Cannot find module express" | Run `npm install` |
| Port already in use | Change PORT in .env or kill process on port 3000 |
| "Invalid signature" | Verify CLICKUP_WEBHOOK_SECRET is exactly correct |
| Webhook not received | Check URL in ClickUp settings matches your server |
| API errors | Verify CLICKUP_API_TOKEN is valid and not expired |
| Task not updating | Check custom field name matches exactly (case-insensitive but must exist) |

## 📱 For Local Testing With ngrok

```bash
# Terminal 1: Start your service
npm run dev

# Terminal 2: Expose to internet
ngrok http 3000

# Copy the HTTPS URL from ngrok (e.g., https://abc123.ngrok.io)
# Use it in ClickUp webhook settings: https://abc123.ngrok.io/webhook/clickup
```

## 📦 Available NPM Scripts

```bash
npm run dev     # Development with auto-reload
npm start       # Production mode
npm install     # Install dependencies
```

## 🔐 Security Checklist

- [ ] Never commit `.env` to git
- [ ] Never share your API token
- [ ] Use HTTPS in production
- [ ] Rotate credentials regularly
- [ ] Keep Node.js updated
- [ ] Monitor logs for suspicious activity
- [ ] Use strong webhook secret

## 📞 Get Help

1. **Quick issues?** See the "Common Issues" table above
2. **Setup questions?** Read `QUICKSTART.md`
3. **System design?** Read `ARCHITECTURE.md`
4. **API reference?** See `README.md`
5. **Test payloads?** Check `WEBHOOK_EXAMPLES.md`
6. **Code issues?** Check source files - they're well-commented

## 🎓 File Guide

| File | Contains |
|------|----------|
| `src/index.js` | Express server & routing |
| `src/routes/webhook.js` | Webhook endpoint handler |
| `src/services/clickupClient.js` | ClickUp API methods |
| `src/services/webhookHandler.js` | Event processing logic ⭐ (edit this for customization) |
| `src/utils/logger.js` | Logging helper |
| `src/utils/security.js` | Signature validation |
| `.env` | Your secrets & config ⚠️ (never commit!) |

## ✅ Verification Checklist

Before considering setup complete:

- [ ] `npm install` runs without errors
- [ ] `.env` file has real ClickUp token & secret
- [ ] `npm run dev` starts without errors
- [ ] `curl http://localhost:3000/health` returns 200 OK
- [ ] ClickUp webhook settings show your service URL
- [ ] You can see logs when updating tasks in ClickUp
- [ ] Task status updates when field is marked complete

---

**Last Updated:** November 17, 2024
**Version:** 1.0.0
**Status:** Production Ready ✅
