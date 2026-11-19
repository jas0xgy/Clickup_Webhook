# ClickUp Webhook Service

A Node.js service with reusable ClickUp webhook automations for sprint routing
and priority-based Business Value.

## Features

- ✅ Secure webhook signature validation
- ✅ Handles ClickUp webhook events (taskUpdated, taskStatusUpdated, taskCommentAdded, listUpdated)
- ✅ Routes positive-estimate tasks to READY TO SCHEDULE or their assigned sprint
- ✅ Reconciles sprint routing daily at 00:05 America/New_York
- ✅ Keeps three future sprints in the Sprint Folder, creating the next sequential sprint as needed
- ✅ Creates linked sprint tasks with descriptions, Sprint Points, and tags
- ✅ Moves the same linked task when rescheduled, preserving development status
- ✅ Maps Backlog Priority to Business Value in any task status
- ✅ ClickUp API integration for reading and updating task data
- ✅ Comprehensive logging
- ✅ Error handling and resilience
- ✅ Ready for local development or cloud deployment

## Prerequisites

- Node.js 22+ and npm
- ClickUp account with API access
- ClickUp API token
- ClickUp webhook secret (generated when creating the webhook)

## Installation

1. Clone or download this project
2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the root directory with your credentials:

```env
CLICKUP_API_TOKEN=your_clickup_api_token_here
CLICKUP_WEBHOOK_SECRET=your_webhook_secret_here
PORT=3000
NODE_ENV=development
```

## Getting Your ClickUp API Token

1. Go to [ClickUp Settings](https://app.clickup.com/settings/developer)
2. Navigate to "API Tokens" in the developer settings
3. Click "Generate" to create a new API token
4. Copy the token and paste it into your `.env` file as `CLICKUP_API_TOKEN`

## Setting Up Webhooks in ClickUp

For local development, ClickUp cannot reach `localhost` directly. A temporary
Cloudflare Tunnel can provide a public HTTPS address:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

Keep both the tunnel and service running. Use the generated HTTPS address with
`/webhook/clickup` appended as the webhook endpoint. The address changes when the
temporary tunnel restarts. Stop the tunnel when testing is finished.

ClickUp returns the webhook secret when a webhook is created through its
[Create Webhook API](https://developer.clickup.com/reference/createwebhook).
Save that secret as `CLICKUP_WEBHOOK_SECRET` and restart the service. Missing or
placeholder secrets are rejected; signature verification must not be disabled.
Requests are verified using HMAC-SHA256 over the original request bytes, with a
hexadecimal signature and a timing-safe comparison.

1. Identify your workspace ID and Space ID.
2. Send an authenticated `POST` to
   `https://api.clickup.com/api/v2/team/{workspace_id}/webhook`.
3. Include your public HTTPS `endpoint`, the desired `events` (for example,
   `["taskUpdated"]`), and the `space_id` in the JSON body. The webhook must
   cover the whole Space: Master Backlog, the Sprint Folder (including folders
   recreated later), and the testing List. A List-scoped webhook misses sprint
   checkbox changes.
4. Save the returned `webhook.secret` in `.env`, then restart the service. Each
   webhook has its own secret, so delete superseded webhooks.
5. Test using a disposable task before using real tasks.

## Running the Service

### Development (with auto-reload):

```bash
npm run dev
```

### Production:

```bash
npm start
```

The service will start on the port specified in your `.env` file (default: 3000).

### Health Check

Check if the service is running:

```bash
curl http://localhost:3000/health
```

You should get a response like:

```json
{
  "status": "ok",
  "timestamp": "2024-11-17T13:15:29.099-05:00"
}
```

## How It Works

### Core Flow

1. ClickUp sends a webhook event to `POST /webhook/clickup`
2. The service validates the webhook signature for security
3. The event is processed based on its type:
   - **taskUpdated**: Dispatches matching `history_items` to registered automation rules
   - **taskStatusUpdated**: Uses the same task automation dispatcher
   - **taskCommentAdded**: Logs comment additions (can be extended)
   - **listUpdated**: Logs list updates (can be extended)
4. The dispatcher fetches the task once, verifies source field IDs, and runs each
   matching rule once using current values rather than stale webhook values.
5. Each rule checks its own conditions and skips unnecessary writes. Failures are
   logged with the task and rule name without blocking other matching rules.
   Webhook and scheduled work on the same task is serialized within this process.
   On Master Backlog tasks, changes to Persona, Goal, Benefit, or Success update
   the managed User Story section once all four inputs are available. Text outside
   the section is preserved. Estimation and testing handoffs also check the source
   story before copying it, so they don't depend on a prior field-change webhook.

### Workflow Validation (Report Only)

At startup and every 15 minutes while running, the service checks active Master
Backlog tasks and terminal tasks updated within the last seven days. It checks
story sections and looks for missing, duplicate, or inconsistent managed copies
in the Estimation, Sprint, and Testing Lists. Search the daily logs for
`Workflow validation finding`. The scan does not update tasks, archive copies,
or post comments. Existing estimation and testing error comments are prefixed
with `[Workflow Agent]` but still attributed to the API token's owner.

### Sprint Routing

Only non-archived tasks whose home List is Master Backlog and whose current
Effort Estimate is a positive number qualify. Numeric strings and positive
fractions are accepted; missing, zero, negative, and nonnumeric estimates are not.

The routing rule reacts to task status, Effort Estimate, and Assigned Sprint
changes. Name and Product changes also synchronize an existing linked
sprint task (its name and Product tag) without rerouting the backlog task. Formula and unrelated custom
field updates do not trigger it. This
replaces the old rule limited to an estimate changing from zero while the task
was AWAITING ESTIMATION.

**Explicit scheduling:** Move a task to SPRINT 0, SPRINT +1, or SPRINT +2 to select
that sprint relative to today. The service writes its exact List name into the
Assigned Sprint text field and its timestamps into the task's start/due dates.
Date writes include time flags to preserve the exact sprint timestamps instead
of ClickUp's date-only normalization to 4 a.m.; the UI can therefore display times.
There is no Target Sprint field. The original task stays in Master Backlog;
a separate linked task lives in the resolved sprint List.

Dragging from any sprint column to another selects that new relative sprint.
Dragging to **READY TO SCHEDULE** explicitly unschedules the task: Assigned
Sprint and the backlog start/due dates are cleared, and its linked sprint item
is archived. This is different from NEW BACKLOG/AWAITING ESTIMATION, which still
restore the existing assignment as described below.

**Reconciliation:** Backward moves to NEW BACKLOG or AWAITING ESTIMATION restore
the status derived from Assigned Sprint:

| Assigned Sprint | Result |
| --- | --- |
| Blank/unset | READY TO SCHEDULE; clear task start/due dates |
| Current sprint | SPRINT 0 |
| Next active sprint | SPRINT +1 |
| Following active sprint | SPRINT +2 |
| Ended, not explicitly recorded as completed | SPRINT 0 |
| List ID recorded in `completedSprintIds` | IN TESTING |

IN TESTING, READY TO DEPLOY, DEPLOYED, COMPLETE, and done/closed status types
are protected. Explicitly clearing Assigned Sprint still clears start/due dates
on a positive-estimate protected task, without moving its status backward.
Other updates to protected tasks do not change their assignment or dates.

The resolver reads actual List start/end timestamps from Sprint Folder. SPRINT 0
is the active sprint containing today; before the first sprint or in a gap
between sprints, it is the next active sprint to start. If every active sprint
has ended, scheduling fails until upcoming sprint Lists are added. It
does not parse yearless names, infer completion
from an end date, or interpret archiving as completion. Archived/completed Lists
remain available to resolve existing assignments but cannot be selected for new
scheduling. Missing dates, overlapping active dates, missing status labels,
unknown assignment names, and offsets outside 0/+1/+2 produce explicit errors
instead of guessed updates.

The daily check preserves Assigned Sprint and advances only its relative status
and synchronized dates. For example, a task assigned to next sprint advances
from SPRINT +1 to SPRINT 0 when that sprint starts; it is not assigned again to a
new "next sprint." A status already matching an existing assignment also keeps
that assignment. To replace an overdue, uncompleted SPRINT 0 assignment with
today's sprint, clear Assigned Sprint first, then move the task into SPRINT 0.

### Linked Sprint Tasks

For qualifying positive-estimate Master Backlog tasks, scheduling into SPRINT
0/+1/+2 also creates one task in the actual sprint List:

- Copies the task name and current description from Master Backlog. Sprint
  tasks get no custom fields, so Sprint Folder needs none.
- Sets native Sprint Points from Effort Estimate and adds the **Item Type**
  selection as a tag when it is Feature or Bug, plus the **Product** label as a
  tag. Other or blank selections add no tags. Enable the Sprint Points, Tags,
  and Priorities ClickApps; otherwise a warning is logged.
- Sets the native priority from **Backlog Priority**: Critical → Urgent;
  Must Have and Workaround Exists → High; Nice to Have → Normal; Minor Impact →
  Low. Blank leaves priority unset; an unmapped option is an error.
- Does not copy the Product, Persona, Goal, Benefit, or Success custom fields.
- Starts new sprint tasks in **backlog** (`sprintTasks.initialStatus` in
  `src/config.js`).
- Adds a native ClickUp task link and a `Backlog task: <url>` line in the sprint
  task description.
- Rescheduling moves the **same sprint task**, removing it from its previous
  home List. Its development status is preserved.
- Later name and Product changes sync one way, from backlog to sprint: the
  Product tag is swapped for the new label (other Product option tags are
  removed), and clearing Product removes it. The copied description,
  points, priority, and tags are refreshed when the sprint task is created, restored, or
  moved, not by later metadata-only edits. Refreshing replaces the sprint task
  description and adds missing tags without removing others.
- IN TESTING and later backlog stages remain protected, but their existing
  linked tasks can still receive metadata updates.
- Dragging to READY TO SCHEDULE or clearing Assigned Sprint archives the linked
  item, hiding it from active sprint views. Views explicitly including archived
  tasks can still show it in its last home List.
- Scheduling again restores that **same task**, moves it to the selected sprint,
  and refreshes its name and copied details without resetting development progress.
  Scheduling back into the same sprint restores it there too.
- Metadata sync pauses while unscheduled. Repeated unscheduling is idempotent;
  it does not create, delete, or repeatedly archive extra tasks.

Destination Lists must support the sprint task's
current status; an incompatible destination produces an error, not a status reset.

`src/services/sprintTasks.js` owns discovery, planning, and application. It shares
the sprint resolver and per-task lock used by webhooks and reconciliation.
Native task links and the description line `Backlog task: <url>` (ending in the
backlog task ID) provide persistent ownership and restart recovery without a
local mapping file. Older items with `Managed backlog task ID: <id>` are still
recognized; that line is replaced the next time the item is restored or moved.
Keep the backlink line and native link intact; do not clone managed descriptions.
Unmarked linked sprint tasks, duplicates, and linked managed items moved outside
Sprint Folder require manual review. Archived managed tasks are restored only
when reconciling an unprotected assignment in an unarchived, uncompleted sprint,
not by metadata-only changes or historical/protected reconciliation.

The daily check and applying reconciliation also repair missing or out-of-sync
items for unprotected assignments in unarchived, uncompleted sprints. They do
not create missing items for protected tasks or completed/archived sprints.
Name or Product changes sync existing items without creating new ones.
Preview remains GET-only and includes a `sprintTask` plan with `create`, `sync`,
`archive`, or `none` actions (`restoring: true` denotes restoration).
Applying reconciliation can therefore create, move, archive, or restore linked
sprint tasks as well as update backlog routing; review the preview first.

### Sprint Configuration and Completion

Non-secret settings live in `src/config.js`: Master Backlog and Sprint Folder
IDs, `completedSprintIds`, `sprintTasks.enabled`/`initialStatus`, and the daily
check time/timezone.

The public API responses inspected here do not expose the native Complete Sprint
state. Continue using Complete Sprint in ClickUp, then **also record that sprint's
List ID** in `sprintRouting.completedSprintIds`. Do not add a sprint until it is
actually completed. Current IDs:

| Sprint | List ID |
| --- | --- |
| Sprint 1 (11/16 - 11/29) | `901718155349` |
| Sprint 2 (11/30 - 12/13) | `901718155350` |
| Sprint 3 (12/14 - 12/27) | `901718158164` |

Keep historical completed IDs in the array. Keep their sprint Lists in Sprint
Folder (they may be archived), and avoid renaming assigned sprints: Assigned
Sprint is resolved by its unique text name. An unknown completed ID stops
reconciliation so a typo cannot silently mark the wrong sprint completed.

Restart with `rs` in nodemon (or restart `npm start`) after editing configuration.
Completion is picked up on relevant task changes or the next daily check. To
preview immediately, without changing any tasks:

```powershell
npm run sprints:preview
```

After reviewing the preview, this command explicitly applies reconciliation to
all eligible tasks in Master Backlog:

```powershell
npm run sprints:reconcile
```

The daily check runs at 00:05 America/New_York, accounting for daylight saving
time. It requires the service and computer to remain running. Starting the
service after the scheduled time does not run an unexpected catch-up bulk
update; use the commands above for a missed run. A failed daily run is logged,
not silently retried all day.

### Automatic Sprint Creation

Before reconciling, the daily check (and `sprints:preview`/`sprints:reconcile`)
makes sure at least `sprintCreation.futureSprints` (3) unarchived, uncompleted
sprints start after today. If not, it creates the next sequential sprint Lists in
the Sprint Folder:

- Numbered after the highest existing `Sprint <n>` and named
  `Sprint <n> (M/D - M/D)`.
- Starting the day after the latest sprint ends, with the same length, from
  00:00 to 23:59:59 America/New_York (daylight saving handled).
- New Lists inherit the Sprint Folder's statuses.

The preview lists planned sprints without creating them. If creation fails, the
error is logged and backlog reconciliation still runs. Set
`sprintCreation.enabled` to `false` to turn this off.

### Daily Health Email

After each daily check, the service emails `healthEmail.to` (john@towpro.io)
with subject **Clickup Webhook Service is healthy** and a summary (tasks
scanned/updated, sprints created). If the check or sprint creation fails, the
subject is **Clickup Webhook Service daily check FAILED** and the body includes
the errors. Email problems are logged and never stop the daily check. No email
arriving means the service or computer was not running.

It sends through Gmail / Google Workspace SMTP. Add to `.env`:

```env
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-character-app-password
# Optional: SMTP_FROM (defaults to SMTP_USER), SMTP_HOST (smtp.gmail.com), SMTP_PORT (587)
```

`SMTP_PASS` must be a Google **app password**, not your normal password: turn on
2-Step Verification for the sending account, then create one at
https://myaccount.google.com/apppasswords (Google Workspace admins may need to
allow app passwords). Any other SMTP provider works by setting `SMTP_HOST` and
`SMTP_PORT`.

Alternatively, use Google OAuth (no app password). When `GMAIL_CLIENT_ID` is
set, OAuth is used instead of `SMTP_PASS`:

1. In Google Cloud Console, enable the **Gmail API** and create an OAuth client
   of type **Desktop app** (for a **Web application** client, add the redirect
   URI `http://localhost:53682/oauth2callback`). On the OAuth consent screen,
   use **Internal** (Workspace) or publish the app; in **Testing** mode Google
   expires refresh tokens after 7 days.
2. Set `SMTP_USER` (the sending Gmail address), `GMAIL_CLIENT_ID`, and
   `GMAIL_CLIENT_SECRET` in `.env`.
3. Run `npm run gmail:auth`, sign in as `SMTP_USER`, and allow access. The
   refresh token is saved to `.env` as `GMAIL_REFRESH_TOKEN`.

Send a test now with `npm run health:email` (uses a read-only preview; nothing
in ClickUp changes).

### Acceptance Testing Hand-off

Checking **Ready for acceptance testing** on a sprint task:

- Creates one copy of its Master Backlog task in the testing List
  (`acceptanceTesting.listId` in `src/config.js`) with status **ready to test**,
  the same copied details as the sprint task (name, description with the
  `Backlog task: <url>` link, Sprint Points, priority, tags), and a native link
  to the backlog task.
- Moves the sprint task to **testing** and the Master Backlog task to
  **IN TESTING**.
- Re-checking reuses the existing copy (found by native link or backlink line)
  instead of creating another; only missing status moves are applied.
- Unchecking does nothing. The sprint task must keep its `Backlog task:` line.

Moving a testing List task to **test complete** moves its linked Master Backlog
task (found through the testing task's `Backlog task:` line) from **IN TESTING**
to **READY TO DEPLOY**. If the backlog task is already READY TO DEPLOY, nothing
happens. If it is in any other status, or the link is missing, the backlog task
is left alone and the automation posts a comment on the testing task (notifying
its watchers) explaining the problem, and logs an error.

Recreating the testing List changes its ID; update `acceptanceTesting.listId`.

### Estimation Hand-off

Moving a Master Backlog task to **AWAITING ESTIMATION** creates one copy in the
Awaiting Estimation List (`estimation.listId` in `src/config.js`) with status
**awaiting estimate**, the same description (story text plus the
`Backlog task: <url>` link) and tags (Item Type Feature/Bug, Product) as sprint
items, and a native link to the backlog task. If a copy already exists (found
by native link or backlink line), no new one is created.

Moving that copy to **estimate ready** with a non-zero Effort Estimate sets the
Master Backlog task's Effort Estimate to the same value. If the estimate is
empty or zero, or the backlink is missing, the backlog task is left alone and
the automation comments on the estimation task (notifying its watchers).

Recreating the Awaiting Estimation List changes its ID; update `estimation.listId`.

### Archiving Hand-off Copies

- Moving a Master Backlog task to **sprint 0**, **sprint +1**, or **sprint +2**
  archives its copies in Awaiting Estimation (`estimation.archiveOnStatuses`).
- Moving a Master Backlog task to **deployed** archives its copies in Testing
  Items (`acceptanceTesting.archiveOnStatuses`).
- Copies are found by native link or `Backlog task:` line; unrelated tasks are
  never archived. If the task later returns to AWAITING ESTIMATION (or is sent
  to acceptance testing again), the archived copy is restored and reset to its
  starting status instead of creating a duplicate.

### Backlog Priority to Business Value

Changing Backlog Priority sets Business Value regardless of task status:

| Backlog Priority | Business Value |
| --- | ---: |
| Critical (Blocker, No work around) | 10 |
| Must Have | 7 |
| Workaround Exists | 5 |
| Nice to Have | 3 |
| Minor Impact | 2 |

The Critical label above is the actual label currently configured in ClickUp.
Clearing Backlog Priority clears Business Value too. This rule does not change
task status or backfill existing tasks until their Backlog Priority changes.
Dropdown selections are resolved by option UUID or `orderindex`, not array
position, so reordering options does not change their mapped Business Value.
If an option is renamed, update its label in the mapping; unknown options are
logged as errors and do not overwrite Business Value.

Writes to Business Value do not retrigger this rule, because it watches only
Backlog Priority. Already-correct target values are not written again.

## Adding Automations (DRY)

Rules live in `src/services/automationRules.js`. The dispatcher in
`src/services/webhookHandler.js` owns event matching, field identity checks,
the shared task fetch, and per-rule error logging. API operations stay in
`src/services/clickupClient.js`. Sprint-specific resolution is shared between
events and the daily check in `src/services/sprintRouting.js`; linked sprint
item behavior lives in `src/services/sprintTasks.js`. The scheduler only decides
when to call the shared workflow.

For another dropdown-to-number mapping, add a factory call to `automationRules`:

```javascript
createDropdownNumberRule({
  name: 'risk-to-risk-score',
  sourceField: 'Risk',
  targetField: 'Risk Score',
  values: {
    High: 10,
    Medium: 5,
    Low: 1
  }
})
```

The factory handles dropdown resolution, numeric writes, clearing the target
when the source is cleared, and avoiding redundant writes.

For field-specific behavior, add a rule object with `name`, `sourceField`,
`matchesChange(change)`, and `async run({ task, field, changes, clickup })`. Inspect
`change.before`/`change.after` in the predicate when the transition matters;
recheck current task state in `run`. Throw descriptive errors for invalid
configuration or failed operations. Add focused tests in
`test/webhookHandler.test.js`; no route or dispatcher changes are needed.
For a rule spanning multiple inputs or status changes, omit `sourceField` and
match all relevant history items in `matchesChange`; verify current field IDs
in the rule before acting, as the sprint resolver does.

New rules still need their fields on the subscribed List and the appropriate
ClickUp events enabled on the webhook. The current webhook watches
`taskUpdated` in Master Backlog only, which also includes status changes. The
dispatcher additionally supports `taskStatusUpdated` if enabled later.
Duplicate status deliveries are reconciled idempotently. There is no durable
queue, cross-process lock, or atomic transaction across ClickUp API calls.
Run one service instance; avoid a manual applying sweep while another instance
is changing the same tasks. Preview uses GET requests only. As before, webhooks
are acknowledged before processing; inspect logs for API/validation failures
and use reconciliation to recover partial writes.

## API Reference

### Available Endpoints

- `POST /webhook/clickup` - Receives ClickUp webhook events
- `GET /health` - Health check endpoint

### ClickUpClient Methods

The `ClickUpClient` class provides these methods:

- `updateTaskStatus(taskId, statusName)` - Update a task's status
- `updateTask(taskId, updates)` - Update status and/or start/due dates together
- `getTask(taskId)` - Fetch task details
- `getList(listId)` - Fetch List status metadata
- `getListFields(listId)` - Read available custom fields
- `getFolderLists(folderId, archived)` - Read active or archived sprint Lists
- `getListTasks(listId, { archived })` - Read all task pages, including subtasks and closed tasks
- `createTask(listId, task)` - Create a task with initial fields and a native link
- `addTaskLink(taskId, sourceId)` - Add a native task link
- `moveTask(workspaceId, taskId, listId, options)` - Move a task's home List using API v3
- `getCustomField(task, fieldName)` - Get a custom field by name
- `getDropdownOption(field)` - Resolve a dropdown's current option
- `setCustomFieldValue(taskId, fieldId, value)` - Set a custom field using ClickUp's dedicated endpoint
- `clearCustomFieldValue(taskId, fieldId)` - Remove a task's custom field value
- `isFieldCompleted(field)` - Check if a field is considered completed

## Troubleshooting

### Local verification

Run `node --test` to check routing, explicit completion, rollover, scheduling,
linked task creation/moves/sync/recovery, Business Value mapping, API requests,
server health, and signature validation.
These tests do not call the ClickUp API.

For a live test, use a disposable task in Master Backlog. Set its status to
AWAITING ESTIMATION with Assigned Sprint blank, then set a positive estimate.
Verify READY TO SCHEDULE. Move it to SPRINT +1 and verify Assigned Sprint and its
dates match the next sprint. Move it backward to NEW BACKLOG and verify it returns
to SPRINT +1 without changing its assignment. Clear Assigned Sprint and verify
READY TO SCHEDULE with start/due dates cleared. Use `sprints:preview` to inspect
bulk results before applying anything. Keep the service and tunnel running.

Check that scheduling creates a linked **backlog** task with the
same name and Product tag in the correct sprint List. Set the sprint task to
**in development**, then move the backlog task to a different sprint column.
Verify that the same sprint task moves Lists without losing its development
status. Rename the backlog task and change/clear its Product to verify one-way
sync. Drag back to READY TO SCHEDULE and verify the assignment/dates clear and
the sprint item is archived. Schedule again into the same or another sprint:
the same item ID and development status must be retained.

Also change Backlog Priority on that task and verify Business Value matches the
table above. Clear the priority and verify Business Value is cleared. Other
task statuses should work identically for this mapping. Refresh the ClickUp
view if API updates are not immediately visible.

### Startup fails with "Cannot find module ... src/index.js"

The server entry point `src/index.js` must be present. Restore it from the
project source, then run `npm run dev` again. Reinstalling dependencies alone
will not restore missing application files.

### Webhook not being received

1. Check that your service is running and accessible from the internet
2. Verify the webhook URL in ClickUp matches your service URL
3. Check the logs for any errors
4. Ensure your firewall/security groups allow inbound traffic on your configured port

### "Invalid signature" errors

1. Verify your `CLICKUP_WEBHOOK_SECRET` matches what ClickUp shows
2. Make sure the secret is exactly copied without extra spaces or characters
3. Test the webhook from ClickUp's webhook page

### API token errors

1. Verify your `CLICKUP_API_TOKEN` is correct
2. Check that your token has the necessary permissions
3. Tokens can expire - regenerate if needed

### "Custom field usages exceeded for your plan" (`FIELD_033`)

This is a ClickUp workspace plan limit, not an API token or AI subscription
issue. ClickUp rejects custom-field writes, including Assigned Sprint and
Business Value. Resolve the workspace's custom-field allowance with ClickUp
before retrying; restarting this service does not reset that allowance.
Task creation and earlier writes may already have succeeded before the error.
Review a GET-only `sprints:preview`, then reconcile once the limit is resolved
to repair partial updates without intentionally creating duplicate sprint items.

### Custom field not being detected

1. Check the exact name of your custom field in ClickUp
2. Field names are case-insensitive in this service
3. Verify the custom field is on the task when the webhook event is sent

## Logging

All activities are logged with timestamps. Logs include:
- Webhook events received
- API calls to ClickUp
- Errors and warnings
- Debug information (in development mode)

Every log line is also appended to a daily file, `logs/YYYY-MM-DD.log`
(git-ignored). Files include debug lines (full webhook payloads) even when the
console hides them, and are deleted after 30 days. Each handled task webhook
adds one `AUDIT` line with JSON: event, task ID, user, changes, and every rule
run with its outcome (`applied`, `skipped`, `flagged`, `failed` + error, ...).

To trace a task, search the logs for its ID, e.g.
`Select-String -Path logs\*.log -Pattern 86e418r6v`.

Settings (`.env`, optional): `LOG_DIR` (default `logs`),
`LOG_RETENTION_DAYS` (default 30), `LOG_TO_FILE=false` to disable. Test runs
never write log files.

## Security

- ✅ Webhook signatures are validated against your secret
- ✅ API token is stored in environment variables (never in code)
- ✅ All requests to ClickUp API use HTTPS
- ⚠️ Never commit your `.env` file or API credentials to version control

## Next Steps & Extensions

This basic service can be extended to:

1. **Database Integration**: Store webhook events and task changes in a database
2. **User Notifications**: Send Slack/email notifications when tasks are updated
3. **Custom Logic**: Implement complex business logic based on field changes
4. **Scheduled Tasks**: Run periodic syncs with ClickUp
5. **Multiple Workspaces**: Handle webhooks from multiple ClickUp workspaces
6. **Audit Logging**: Track all automatic updates for compliance

## License

ISC

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review ClickUp's API documentation: https://clickup.com/api
3. Check server logs for error messages
