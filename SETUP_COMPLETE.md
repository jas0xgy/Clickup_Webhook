# 🚀 ClickUp Webhook Service - Setup Complete!

Your Node.js ClickUp webhook service is ready to use!

## 📂 What You Got

A complete, production-ready Node.js service that:
- ✅ Listens for ClickUp webhooks
- ✅ Validates webhook signatures securely
- ✅ Monitors custom field changes
- ✅ Automatically updates task status when fields are completed
- ✅ Includes comprehensive logging
- ✅ Ready for local development or cloud deployment

## 🎯 Your Use Case

**What it does right now:**
When a custom field on a task is marked as "completed", the entire task's status automatically updates to "completed".

Example flow:
```
1. You have a task with a "Review" custom field
2. Someone marks "Review" as completed ✓
3. ClickUp sends a webhook to your service
4. Your service automatically updates the task status to "completed"
5. Done! The task now shows as complete everywhere
```

## 📁 Project Location

```
C:\Users\g8r34\Desktop\clickup-webhook-service
```

## 🏗️ Project Structure

```
clickup-webhook-service/
├── src/                           # Source code
│   ├── index.js                   # Main Express server
│   ├── routes/webhook.js          # Webhook endpoint
│   ├── services/
│   │   ├── clickupClient.js       # ClickUp API integration
│   │   └── webhookHandler.js      # Event processing logic
│   └── utils/
│       ├── logger.js              # Logging
│       └── security.js            # Signature validation
├── .env                           # Environment variables (keep secret!)
├── package.json                   # Dependencies
├── README.md                      # Full documentation
├── QUICKSTART.md                  # 5-minute setup
├── WEBHOOK_EXAMPLES.md            # Test payloads
└── ARCHITECTURE.md                # System design
```

## ⚡ Getting Started (5 Minutes)

### Step 1: Install Dependencies
```bash
cd C:\Users\g8r34\Desktop\clickup-webhook-service
npm install
```

### Step 2: Get Your ClickUp API Token
1. Visit: https://app.clickup.com/settings/developer
2. Go to "API Tokens"
3. Click "Generate"
4. Copy the token

### Step 3: Configure `.env`
Edit the `.env` file and replace:
```env
CLICKUP_API_TOKEN=your_token_here
CLICKUP_WEBHOOK_SECRET=will_get_this_in_next_step
PORT=3000
NODE_ENV=development
```

### Step 4: Set Up ClickUp Webhook
1. Go to: https://app.clickup.com/settings/integrations
2. Find "Webhooks" under API section
3. Click "Add Webhook"
4. Set URL: `http://localhost:3000/webhook/clickup`
5. Select events:
   - ✓ Task Updated
   - ✓ Task Status Updated
   - ✓ Task Comment Added
   - ✓ List Updated
6. ClickUp shows "Webhook Secret" → Copy it
7. Paste into `.env` as `CLICKUP_WEBHOOK_SECRET`
8. Save!

### Step 5: Start the Service
```bash
npm run dev
```

You should see:
```
[13:15:29] INFO: ClickUp webhook service listening on port 3000
[13:15:29] INFO: Health check: http://localhost:3000/health
```

### Step 6: Test It
1. Open a task in ClickUp
2. Update a custom field
3. Check your terminal - you should see logs!

## 🔧 Key Features

### 1. Security
- Webhook signature validation using HMAC-SHA256
- API token stored securely in environment variables
- Never exposes sensitive data in logs

### 2. Event Handling
- **taskUpdated**: Detects custom field changes
- **taskStatusUpdated**: Logs status changes
- **taskCommentAdded**: Logs new comments
- **listUpdated**: Logs list modifications

### 3. ClickUp Integration
- Full ClickUp API v2 client included
- Methods to read and update tasks
- Custom field detection and analysis
- Error handling for API failures

### 4. Logging
- Timestamped logs for debugging
- Different log levels (info, warn, error, debug)
- Production-ready error messages

## 📚 Documentation Files

| File | Purpose |
|------|---------|
| **README.md** | Complete documentation & reference |
| **QUICKSTART.md** | 5-minute setup guide |
| **WEBHOOK_EXAMPLES.md** | Example payloads for testing |
| **ARCHITECTURE.md** | System design & data flow |
| **.env** | Your API credentials (keep secret!) |

## 🌍 For Testing Without a Public Server

Use ngrok to expose your local service to the internet:

```bash
# Install ngrok
npm install -g ngrok

# In another terminal, run:
ngrok http 3000

# You'll get a URL like: https://abc123.ngrok.io
# Use this in ClickUp: https://abc123.ngrok.io/webhook/clickup
```

## ☁️ Deploying to Production

When ready to run this in production, you can deploy to:

1. **Heroku** (easiest)
   - Create account at heroku.com
   - Deploy directly from CLI

2. **AWS Lambda** (serverless)
   - Zero cost when not in use
   - Scales automatically

3. **DigitalOcean App Platform**
   - $5/month affordable option
   - Easy deployment

4. **Traditional VPS**
   - Full control
   - Use PM2 to keep service running

5. **Docker Container**
   - Portable and consistent
   - Easy scaling

See README.md for more deployment details.

## 🎓 Next Steps

1. **Immediate**: Complete the 5-minute setup above
2. **Testing**: Send a test webhook (see WEBHOOK_EXAMPLES.md)
3. **Customize**: Modify webhookHandler.js for your specific needs
4. **Extend**: Add logging to database, Slack notifications, etc.
5. **Deploy**: Move to production when ready

## 🔄 Customization Ideas

Need to do something different? Here are common modifications:

### Update to Different Status
In `src/services/webhookHandler.js`, change:
```javascript
await clickup.updateTaskStatus(taskId, 'completed');
```
To:
```javascript
await clickup.updateTaskStatus(taskId, 'in progress');
```

### Watch Specific Fields Only
Modify the field detection logic to only trigger for certain fields:
```javascript
if (fieldName === 'Approval' || fieldName === 'Review') {
  // Only update for these specific fields
}
```

### Add Slack Notifications
Install slack SDK and send notifications when updates happen:
```bash
npm install @slack/web-api
```

### Save to Database
Add a database connection and log all changes:
```javascript
db.save({ taskId, fieldName, timestamp });
```

## 🆘 Troubleshooting

### "Cannot find module 'express'"
Solution: Run `npm install`

### Webhook not being received
1. Verify URL in ClickUp matches your service URL
2. Check firewall allows port 3000
3. Use ngrok if testing locally
4. Check terminal logs for errors

### "Invalid signature" errors
1. Copy CLICKUP_WEBHOOK_SECRET exactly from ClickUp
2. No spaces or extra characters
3. Make sure it's in the .env file

### Task status not updating
1. Verify CLICKUP_API_TOKEN is correct
2. Check the custom field name matches exactly
3. Look at terminal logs for error messages
4. Try test payload from WEBHOOK_EXAMPLES.md

## 📞 Getting Help

1. Check the **README.md** for detailed documentation
2. Review **WEBHOOK_EXAMPLES.md** for test payloads
3. Check **ARCHITECTURE.md** to understand the system
4. Look at terminal logs for specific error messages
5. Verify your API token and webhook secret are correct

## 📝 Important Reminders

⚠️ **SECURITY**
- Never commit `.env` to git
- Never share your API token or webhook secret
- Rotate credentials periodically
- Keep Node.js and npm updated

✅ **TESTING**
- Always test with a development workspace first
- Use ngrok for local testing
- Monitor logs carefully
- Start with simple tests before complex logic

🚀 **PRODUCTION**
- Use HTTPS URLs only
- Monitor service uptime
- Set up error alerts
- Keep backups of your code

## 📧 Summary

You now have a fully functional Node.js service that:
1. Listens for ClickUp webhooks
2. Validates request signatures
3. Processes custom field changes
4. Updates task status automatically
5. Logs all activities
6. Scales to production

**You're all set to start automating your ClickUp workflows!** 🎉

Questions? Read the docs or dive into the code. The service is well-commented and straightforward.

Good luck! 🚀
