# 🆘 Troubleshooting Guide

## Problem: "Cannot find module 'express'"

### Error Message:
```
Error: Cannot find module 'express'
```

### Solution:
You need to install dependencies first.

```bash
npm install
```

This will read `package.json` and install all required packages.

---

## Problem: Port 3000 Already in Use

### Error Message:
```
Error: listen EADDRINUSE: address already in use :::3000
```

### Solution (Choose One):

**Option A: Use a Different Port**
```bash
# Edit .env and change:
PORT=3001
# Then restart the service
```

**Option B: Kill the Process Using Port 3000**
```bash
# Find what's using port 3000
netstat -ano | findstr :3000

# Kill it (replace PID with actual process ID)
taskkill /PID 1234 /F
```

**Option C: Stop the Service Properly**
In the terminal where the service is running, press `Ctrl+C` to stop it.

---

## Problem: Webhook Not Being Received

### Symptoms:
- No logs appearing when you update tasks in ClickUp
- ClickUp says webhook is "unverified"

### Troubleshooting Steps:

**Step 1: Verify Service is Running**
```bash
curl http://localhost:3000/health
```

Should return:
```json
{"status": "ok", "timestamp": "..."}
```

If you get an error, the service isn't running. Start it with `npm run dev`.

**Step 2: Check ClickUp Webhook URL**
- Go to: https://app.clickup.com/settings/integrations
- Find your webhook
- Verify URL matches exactly: `http://localhost:3000/webhook/clickup`

If testing locally, use ngrok:
```bash
ngrok http 3000
# Then use the HTTPS URL ngrok provides
```

**Step 3: Verify Events are Selected**
In ClickUp webhook settings, check these are selected:
- ✓ Task Updated
- ✓ Task Status Updated
- ✓ Task Comment Added
- ✓ List Updated

**Step 4: Check Firewall**
- Windows Firewall might be blocking port 3000
- Create an inbound rule allowing Node.js or port 3000

**Step 5: Test with ClickUp's Test Button**
- In ClickUp webhook settings, click "Test"
- Check your terminal for logs
- Look for validation errors

---

## Problem: "Invalid Signature" Errors

### Error Message:
```
[timestamp] WARN: Invalid webhook signature received
```

### Solution:

**Step 1: Verify Webhook Secret**
```bash
# In .env, check:
CLICKUP_WEBHOOK_SECRET=paste_exact_value_from_clickup
```

The secret must match exactly - no spaces, quotes, or extra characters.

**Step 2: Get the Correct Secret**
1. Go to: https://app.clickup.com/settings/integrations
2. Find your webhook
3. Look for "Webhook Secret" or similar label
4. Copy the ENTIRE value
5. Paste exactly into `.env`

**Step 3: Restart Service**
After changing `.env`, stop (`Ctrl+C`) and restart with `npm run dev`.

**Step 4: Test Again**
Send a test webhook from ClickUp or test locally with curl.

---

## Problem: "Invalid or Missing API Token" (401 Error)

### Error Message:
```
[timestamp] ERROR: Failed to update task status: Unauthorized
```

### Solution:

**Step 1: Get Valid API Token**
1. Visit: https://app.clickup.com/settings/developer
2. Click "API Tokens"
3. If no tokens exist, click "Generate"
4. Copy the token (long string)

**Step 2: Update .env**
```bash
CLICKUP_API_TOKEN=paste_token_here
```

**Step 3: Verify Token Format**
- It should be a long alphanumeric string
- No spaces at beginning or end
- No quotes around it

**Step 4: Check Token Permissions**
- Some workspaces restrict API access
- Verify your user has API access enabled
- In ClickUp settings, check "API" is enabled for your team

**Step 5: Restart Service**
```bash
# Press Ctrl+C to stop
# Then start again:
npm run dev
```

**Step 6: Verify with curl**
```bash
curl -H "Authorization: YOUR_TOKEN" https://api.clickup.com/api/v2/user
```

Should return user info (not an error).

---

## Problem: Task Status Not Updating

### Symptoms:
- Webhook is received (you see logs)
- No "Invalid signature" error
- But task status doesn't change

### Troubleshooting:

**Step 1: Check Custom Field Name**
In `src/services/webhookHandler.js`, the code looks for fields by name. 

Verify the field name in ClickUp matches what the service expects:
```javascript
// Current code (line ~50):
const fieldName = change.name;
logger.info(`Custom field "${fieldName}" changed to: ${newValue}`);
```

Look at the logs to see what field name is being detected.

**Step 2: Verify Field Completion Detection**
The code checks if a field is "completed". Different field types work differently:
- **Checkbox**: `true` = completed
- **Text/Select**: `"completed"` or `"true"` = completed
- **Number**: value > 0 = completed

If your field has different values, modify `isFieldCompleted()` in `clickupClient.js`:
```javascript
isFieldCompleted(field) {
  // Add your custom logic here
  const value = field.value;
  // e.g., check for "done" instead of "completed"
  return value === 'done';
}
```

**Step 3: Check API Token Permissions**
The token needs permission to update tasks:
```bash
# Test with curl:
curl -X PUT https://api.clickup.com/api/v2/task/TASK_ID \
  -H "Authorization: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

**Step 4: Check Task Exists**
Make sure the task ID in the webhook is valid and you have access to it.

**Step 5: Review Full Logs**
Enable debug logging in `.env`:
```env
NODE_ENV=development
```

This shows more detailed information about what's happening.

---

## Problem: "Cannot Connect to ClickUp API"

### Error Message:
```
Error: getaddrinfo ENOTFOUND api.clickup.com
```

### Solution:

**Step 1: Check Internet Connection**
```bash
ping google.com
```

If this fails, you don't have internet access.

**Step 2: Check ClickUp API Status**
Visit: https://status.clickup.com
See if ClickUp API is experiencing issues.

**Step 3: Check Firewall/Proxy**
Your network might be blocking outbound HTTPS:
- Check corporate firewall settings
- Check if behind a proxy
- Try with VPN enabled/disabled

**Step 4: Verify API URL**
In `src/services/clickupClient.js`, the URL is:
```javascript
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
```

This should be correct. Only change if ClickUp publishes a new API URL.

---

## Problem: Service Keeps Crashing

### Symptoms:
- Service starts but crashes after a few seconds
- Error messages appear then it stops

### Solution:

**Step 1: Look at the Error Message**
The error message tells you what's wrong. Common ones:
- Missing module → Run `npm install`
- Port in use → Change PORT in .env
- Invalid JSON in .env → Check for quotes/commas

**Step 2: Check .env File**
Make sure .env is valid:
```bash
# ✓ Correct:
CLICKUP_API_TOKEN=abc123def456
PORT=3000

# ✗ Wrong (extra quotes):
CLICKUP_API_TOKEN="abc123def456"
PORT="3000"

# ✗ Wrong (missing value):
CLICKUP_API_TOKEN=
```

**Step 3: Run with Debug Info**
```bash
NODE_ENV=development npm run dev
```

This shows more error details.

**Step 4: Check for JavaScript Errors**
If you modified code, verify there are no syntax errors:
```bash
node -c src/index.js
```

**Step 5: Reinstall Dependencies**
```bash
# Remove node_modules
rm -r node_modules

# Reinstall
npm install

# Try again
npm run dev
```

---

## Problem: Testing With ngrok

### Issue: ngrok URL keeps changing

### Solution:
Use ngrok's paid tier for a permanent URL, or:

1. Update ClickUp webhook URL each time ngrok starts
2. Use automation to update ClickUp webhook via API
3. Keep the ngrok command running (don't close the terminal)

### ngrok Setup:
```bash
# Install
npm install -g ngrok

# Start ngrok (in separate terminal)
ngrok http 3000

# Copy HTTPS URL (e.g., https://abc123.ngrok.io)
# Use in ClickUp: https://abc123.ngrok.io/webhook/clickup
```

---

## Problem: Can't Find .env File

### Solution:

**Windows:**
Make sure you're in the right directory:
```bash
cd C:\Users\g8r34\Desktop\clickup-webhook-service
dir
# Should show: .env among other files
```

**Hidden Files:**
On Windows, files starting with "." are hidden by default:
1. Open File Explorer
2. Go to: View → Show → Hidden items
3. Now you can see .env

---

## Problem: Changes to Code Not Taking Effect

### Issue:
You modified a file but changes aren't showing up.

### Solution:

**If using `npm run dev`:**
Nodemon should auto-reload. If it doesn't:
1. Stop the service (`Ctrl+C`)
2. Start it again (`npm run dev`)

**If using `npm start`:**
You must restart manually:
1. Stop the service (`Ctrl+C`)
2. Start it again (`npm start`)

**If still not working:**
1. Close all Node.js processes
2. Clear any caches: `rm -r node_modules/.cache`
3. Restart the service

---

## Problem: Need to Update Status to Something Else

### Issue:
You want tasks to update to "in progress" instead of "completed"

### Solution:

**Edit:** `src/services/webhookHandler.js`

**Find this line (around line 54):**
```javascript
await clickup.updateTaskStatus(taskId, 'completed');
```

**Change to:**
```javascript
await clickup.updateTaskStatus(taskId, 'in progress');
```

**Save and restart** (`Ctrl+C` then `npm run dev`)

---

## Problem: Need to Only Watch Specific Fields

### Issue:
You have many custom fields but only want to trigger for one

### Solution:

**Edit:** `src/services/webhookHandler.js`

**Find this section (around line 50):**
```javascript
for (const change of changes) {
  if (change.field === 'custom_field') {
    const fieldName = change.name;
    // ... rest of code
  }
}
```

**Add a check:**
```javascript
for (const change of changes) {
  if (change.field === 'custom_field') {
    const fieldName = change.name;
    
    // Only trigger for specific fields
    if (fieldName === 'Review' || fieldName === 'Approval') {
      // ... rest of code
    }
  }
}
```

**Save and restart.**

---

## Can't Find the Solution?

**Check these files in order:**
1. `QUICK_REFERENCE.md` - Quick answers
2. `README.md` - Complete documentation
3. `ARCHITECTURE.md` - How it works
4. `src/services/webhookHandler.js` - Main logic (read comments)

**Still stuck?**
1. Check the terminal output carefully - error messages are helpful
2. Enable debug logging in .env: `NODE_ENV=development`
3. Add `console.log()` statements in the code where you're stuck
4. Test the ClickUp API directly with curl
5. Verify your API token and webhook secret are exactly correct

---

**Last Updated:** November 17, 2024
**Version:** 1.0.0
