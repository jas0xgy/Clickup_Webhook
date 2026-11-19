# Example Webhook Payloads

This file contains example webhook payloads from ClickUp that you can use for testing.

## Example 1: Task Updated (Effort Estimate Changed)

This is what ClickUp sends when a custom field on a task is changed:

```json
{
  "event": "taskUpdated",
  "task_id": "9hz6xkd5t",
  "history_items": [
    {
      "field": "custom_field",
      "custom_field": {
        "id": "your-effort-estimate-field-id",
        "name": "Effort Estimate",
        "type": "number"
      },
      "before": "0",
      "after": "3"
    }
  ]
}
```

`before` can also be `null`, absent, or an empty string. The service fetches the
task and reconciles sprint routing if the current estimate is positive. With
Assigned Sprint blank, an unprotected task becomes READY TO SCHEDULE. Otherwise
its assignment determines the relative sprint status or IN TESTING. The rule
also runs when an existing positive estimate changes.

## Example 2: Task Status Updated

This is what ClickUp sends when a task's status changes:

```json
{
  "event": "taskStatusUpdated",
  "task_id": "9hz6xkd5t",
  "history_items": [
    {
      "field": "status",
      "before": { "status": "ready to schedule" },
      "after": { "status": "sprint +1" }
    }
  ]
}
```

ClickUp also sends status changes as `taskUpdated`; the current webhook subscribes
to that event. A deliberate sprint status move writes the selected sprint name
and dates. Moving an assigned task back to NEW BACKLOG instead restores its
assigned sprint's current relative status.
Moving to READY TO SCHEDULE instead explicitly clears Assigned Sprint and task
dates and archives the linked sprint item. Scheduling it again restores that
same item in the selected sprint with its development status preserved.

Changes to any of the Persona, Goal, Benefit, or Success custom fields also
refresh the task description using their current values:

```text
Persona Goal Benefit.\r\nSuccess is when Success.
```

## Example 3: Task Comment Added

This is what ClickUp sends when someone adds a comment:

```json
{
  "event": "taskCommentAdded",
  "task_id": "9hz6xkd5t",
  "webhook_data": {
    "task_id": "9hz6xkd5t",
    "comment": "This is a comment on the task",
    "created_at": "1623888234000",
    "timestamp": "1623888234000",
    "user": {
      "id": 123456,
      "username": "john_doe",
      "email": "john@example.com"
    }
  }
}
```

## Example 4: List Updated

This is what ClickUp sends when a list is updated:

```json
{
  "event": "listUpdated",
  "list_id": "900500",
  "webhook_data": {
    "list_id": "900500",
    "name": "My Updated List",
    "created_at": "1572478701000",
    "updated_at": "1623888234000",
    "timestamp": "1623888234000"
  }
}
```

## Safe Local Testing

Run the automated rule and signature tests without making any ClickUp API calls:

```powershell
node --test
```

For a live automation test, use a disposable task in the subscribed List.
Leave Assigned Sprint blank and set a positive Effort Estimate. Confirm it
becomes READY TO SCHEDULE. Move it to SPRINT +1 and check its assignment and
dates. Move it back to NEW BACKLOG and check it returns to SPRINT +1.
Scheduling also creates a linked sprint task in the actual next sprint List,
initially **backlog**, with matching name, the copied
description and backlog backlink, Effort Estimate as Sprint Points, Backlog
Priority as the native priority, and the Item Type (Feature or Bug) and Product
as tags.
Change its development status, then reschedule the backlog task to SPRINT +2:
the same linked task must move Lists and retain its development status.

Run `npm run sprints:preview` for a read-only bulk routing preview. See README
for explicitly recording completed sprint List IDs; native Complete Sprint
alone is not detectable through the List API responses used here.

Never disable signature validation. Unsigned requests should return HTTP 401.

## Testing With Signature (Advanced)

For a harmless connection test with proper signature validation:

1. Create a test script (Node.js):

```javascript
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const webhook_secret = process.env.CLICKUP_WEBHOOK_SECRET;
const payload = {
  event: "connectionTest"
};

const bodyString = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', webhook_secret).update(bodyString).digest('hex');

axios.post('http://localhost:3000/webhook/clickup', bodyString, {
  headers: {
    'Content-Type': 'application/json',
    'x-signature': signature
  }
}).then(res => console.log('Success:', res.data))
  .catch(err => console.error('Error:', err.response?.data || err.message));
```

2. Run it:

```bash
node test-webhook.js
```

## Sprint Routing Checks

- Positive estimate, no Assigned Sprint: READY TO SCHEDULE.
- Explicit move to SPRINT 0/+1/+2: resolve and store that sprint's name/dates.
- Backward move with an existing assignment: restore its relative sprint status.
- Ended, uncompleted sprint: SPRINT 0, not IN TESTING.
- Sprint explicitly registered as completed: IN TESTING.
- Clear Assigned Sprint: clear dates; unprotected tasks become READY TO SCHEDULE.
- IN TESTING and later stages: preserve status.
- Zero, blank, negative, or nonnumeric estimate: do not route.
- Formula or unrelated field updates: do not trigger sprint routing.
- Name or Product updates: sync an existing linked sprint item one way;
  do not schedule the backlog task or reset its workflow status.
- Clear Product: remove the Product tag from the sprint task.
- Drag to READY TO SCHEDULE or clear Assigned Sprint: archive the linked item.
- Reschedule after unscheduling: restore the same item ID, preserve development
  status, and move it to the selected sprint (or restore in place).
- Repeated deliveries: reuse the same managed item rather than creating copies.
