# Quick Start Guide

This guide will get your ClickUp webhook service running in 5 minutes.

## Step 1: Install Dependencies (1 minute)

```bash
npm install
```

## Step 2: Get Your ClickUp API Token (2 minutes)

1. Visit: https://app.clickup.com/settings/developer
2. Click "API Tokens"
3. Click "Generate" 
4. Copy the token

## Step 3: Configure Environment Variables (1 minute)

Edit the `.env` file and add:

```env
CLICKUP_API_TOKEN=paste_your_token_here
CLICKUP_WEBHOOK_SECRET=will_get_this_next
PORT=3000
NODE_ENV=development
```

## Step 4: Set Up Webhook in ClickUp (1 minute)

1. Go to: https://app.clickup.com/settings/integrations
2. Find "API" or "Developer" section
3. Click "Webhooks"
4. Click "Add Webhook"
5. Set URL to: `http://localhost:3000/webhook/clickup`
6. Select events:
   - ✓ Task Updated
   - ✓ Task Status Updated
   - ✓ Task Comment Added
   - ✓ List Updated
7. ClickUp will show you a **Webhook Secret** - copy it
8. Paste it into `.env` as `CLICKUP_WEBHOOK_SECRET`
9. Click "Save"

## Step 5: Start the Service

```bash
npm run dev
```

You should see:
```
[timestamp] INFO: ClickUp webhook service listening on port 3000
[timestamp] INFO: Health check: http://localhost:3000/health
```

## Step 6: Test It Out

1. In ClickUp, create or open a task
2. Add a custom field or update an existing one
3. Mark a custom field as "Completed"
4. Check the terminal - you should see log messages!

## Example: Auto-Complete Task When Field is Marked Done

Scenario: You have a task with a "Review" custom field. When someone marks it as "Completed", the entire task should mark as completed.

1. Create a task in ClickUp
2. Add a custom field called "Review" (text, checkbox, or select type)
3. Mark the "Review" field as completed/checked
4. The service automatically updates the task status to "completed"
5. Check terminal for confirmation logs

## For Local Testing (No Public Server Yet)

If you don't have a public server, you can use ngrok for local testing:

```bash
# Install ngrok if you haven't
npm install -g ngrok

# In another terminal, expose your local server
ngrok http 3000

# You'll get a URL like: https://abc123.ngrok.io
# Use https://abc123.ngrok.io/webhook/clickup in ClickUp webhook settings
```

## Troubleshooting

### Service won't start
- Check that port 3000 is not in use
- Verify Node.js is installed: `node --version`

### Not receiving webhooks
- Verify the webhook URL in ClickUp is correct
- Check your `.env` file has the right token and secret
- Look at terminal logs for error messages

### Invalid signature errors
- Double-check `CLICKUP_WEBHOOK_SECRET` - copy it exactly from ClickUp
- No spaces or extra characters

## Next Steps

1. Read the full [README.md](./README.md) for more details
2. Explore the code in `src/` directory
3. Customize the event handlers in `src/services/webhookHandler.js`
4. Consider moving to a production server like Heroku, AWS, or DigitalOcean

Happy automating! 🚀
