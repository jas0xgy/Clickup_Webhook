const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');

const tagField = 'Item Type';
const tagOptions = new Set(['feature', 'bug']);
const productTagField = 'Product';
const priorityField = 'Backlog Priority';
// ClickUp priorities: 1 urgent, 2 high, 3 normal, 4 low. Labels match by prefix ("Critical (Blocker, ...)").
const priorityMap = [
  ['critical', 1], ['must have', 2], ['workaround exists', 2], ['nice to have', 3], ['minor impact', 4]
];
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isEmpty = value => value == null || value === '';
const legacyMarkerFor = sourceId => `Managed backlog task ID: ${sourceId}`;
const backlinkFor = source => `Backlog task: ${source.url || `https://app.clickup.com/t/${source.id}`}`;
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
const priorityOf = item => Number(item.priority?.id) || null;
const hasTag = (item, tag) => (item.tags || []).some(value => normalize(value?.name) === normalize(tag));

// The backlink line doubles as the ownership marker; the legacy line is still recognized.
function isManaged(item, sourceId) {
  return [item.description, item.text_content].some(text =>
    typeof text === 'string' && text.split(/\r?\n/).map(line => line.trim()).some(line =>
      line === legacyMarkerFor(sourceId) ||
      (line.startsWith('Backlog task: ') && line.endsWith(`/t/${sourceId}`))));
}

// Returns the backlog task ID a managed copy points to, from its backlink or legacy marker line.
function sourceIdOf(item) {
  for (const text of [item.description, item.text_content]) {
    if (typeof text !== 'string') continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const match = /^Backlog task: \S*\/t\/([^/\s]+)$/.exec(line) || /^Managed backlog task ID: (\S+)$/.exec(line);
      if (match) return match[1];
    }
  }
  return null;
}

function linkedIds(task) {
  if (!Array.isArray(task.linked_tasks)) {
    throw new Error(`Task ${task.id} has no linked_tasks metadata; cannot safely discover its sprint item`);
  }
  const ids = task.linked_tasks.map(link => {
    if (link.task_id === task.id && typeof link.link_id === 'string') return link.link_id;
    if (link.link_id === task.id && typeof link.task_id === 'string') return link.task_id;
    throw new Error(`Task ${task.id} has an invalid task link`);
  });
  return [...new Set(ids)].filter(id => id !== task.id);
}

class SprintTasks {
  constructor(clickup, config) {
    this.clickup = clickup;
    this.config = config;
  }

  dropdownLabel(source, name) {
    const field = this.clickup.getCustomField(source, name);
    if (isEmpty(field?.value)) return null;
    const label = field.type === 'drop_down' && this.clickup.getDropdownOption(field)?.name?.trim();
    if (!label) throw new Error(`Cannot resolve "${name}" dropdown value "${field.value}"`);
    return label;
  }

  // Product is carried only as a tag; other Product option labels are stale tags to remove.
  productTags(source) {
    const current = this.dropdownLabel(source, productTagField);
    const options = this.clickup.getCustomField(source, productTagField)?.type_config?.options || [];
    const stale = options.map(option => option.name?.trim())
      .filter(name => name && normalize(name) !== normalize(current));
    return { current, stale };
  }

  sprintTags(source) {
    const itemType = this.dropdownLabel(source, tagField);
    return [itemType && tagOptions.has(normalize(itemType)) ? itemType : null,
      this.productTags(source).current].filter(Boolean);
  }

  sprintPriority(source) {
    const label = this.dropdownLabel(source, priorityField);
    if (!label) return null;
    const match = priorityMap.find(([prefix]) => normalize(label).startsWith(prefix));
    if (!match) throw new Error(`No ClickUp priority mapping for "${priorityField}" option "${label}"`);
    return match[1];
  }

  // Description (story text plus backlink) and tags shared by every managed copy of a backlog task.
  copiedText(source) {
    // List responses may omit descriptions; never replace a copy's description with only the backlink then.
    const description = typeof source.description === 'string' ?
      [source.description.trim(), backlinkFor(source)].filter(Boolean).join('\n\n') : null;
    return { description, tags: this.sprintTags(source) };
  }

  copiedDetails(source) {
    const points = numberValue(this.clickup.getCustomField(source, 'Effort Estimate')?.value);
    if (!(points > 0)) throw new Error(`Backlog task ${source.id} has no positive Effort Estimate for Sprint Points`);
    const { description, tags } = this.copiedText(source);
    return { description, points, tags, priority: this.sprintPriority(source) };
  }

  async inventory(catalog) {
    if (!catalog.sprintTaskInventory) {
      catalog.sprintTaskInventory = Promise.all(catalog.sprints.map(async sprint => {
        const pages = await Promise.all([
          this.clickup.getListTasks(sprint.id),
          this.clickup.getListTasks(sprint.id, { archived: true })
        ]);
        return pages.flat();
      })).then(async pages => {
        const items = [...new Map(pages.flat().map(item => [item.id, item])).values()];
        return Promise.all(items.map(item =>
          typeof item.description === 'string' || typeof item.text_content === 'string' ?
            item : this.clickup.getTask(item.id)));
      });
    }
    return catalog.sprintTaskInventory;
  }

  async findItem(source, catalog) {
    const linked = [];
    const unmarked = [];
    for (const id of linkedIds(source)) {
      let item;
      try {
        item = await this.clickup.getTask(id);
      } catch (error) {
        if (error.response?.status !== 404) throw error;
        logger.warn(`Linked task ${id} on backlog task ${source.id} no longer exists`);
        continue;
      }
      if (String(item.list?.id) === String(this.config.acceptanceTesting?.listId)) continue;
      if (String(item.list?.id) === String(this.config.estimation?.listId)) continue;
      if (isManaged(item, source.id)) linked.push(item);
      else if (catalog.sprints.some(sprint => sprint.id === String(item.list?.id))) unmarked.push(item.id);
    }
    let matches = linked;
    if (matches.length === 0) {
      matches = (await this.inventory(catalog)).filter(item => isManaged(item, source.id));
    }
    if (matches.length > 1) {
      throw new Error(`Backlog task ${source.id} has multiple managed sprint items; resolve duplicates before syncing`);
    }
    if (matches.length === 0) {
      if (unmarked.length > 0) {
        throw new Error(`Backlog task ${source.id} links to unmarked sprint task(s) ${unmarked.join(', ')}; review before creating another item`);
      }
      return null;
    }
    const item = linked.includes(matches[0]) ? matches[0] : await this.clickup.getTask(matches[0].id);
    if (!isManaged(item, source.id)) throw new Error(`Sprint item ${item.id} no longer has its source task marker`);
    if (item.id === source.id || !catalog.sprints.some(sprint => sprint.id === String(item.list?.id))) {
      throw new Error(`Managed sprint item ${item.id} is outside Sprint Folder; review it instead of creating a duplicate`);
    }
    return item;
  }

  async prepare(source, sprint, catalog, { allowCreate = true } = {}) {
    const item = await this.findItem(source, catalog);
    if (!sprint) {
      return item ? {
        sourceId: source.id, itemId: item.id, listId: String(item.list.id),
        action: 'archive', changed: item.archived !== true, expectedStatus: item.status?.status
      } : { changed: false, action: 'none', reason: 'No existing sprint item to archive' };
    }
    if (!item && !allowCreate) {
      return { changed: false, action: 'none', reason: 'No existing sprint item; historical/protected tasks are not backfilled' };
    }
    if (item?.archived && !allowCreate) {
      return { changed: false, action: 'none', itemId: item.id, reason: 'Archived sprint item awaits active scheduling' };
    }
    if (typeof source.name !== 'string' || !source.name.trim()) {
      throw new Error(`Backlog task ${source.id} has no valid task name`);
    }
    const list = await this.clickup.getList(sprint.id);
    if (!Array.isArray(list.statuses)) throw new Error(`Sprint List ${sprint.id} has no status metadata`);
    const base = { sourceId: source.id, listId: sprint.id, name: source.name };
    if (!item) {
      const status = list.statuses.find(value => normalize(value.status) === normalize(this.config.sprintTasks.initialStatus));
      if (!status) throw new Error(`Sprint "${sprint.name}" has no "${this.config.sprintTasks.initialStatus}" status`);
      const details = this.copiedDetails(source);
      return {
        ...base, changed: true, action: 'create', expectedStatus: status.status, details,
        create: {
          name: source.name, status: status.status, links_to: source.id,
          description: details.description || backlinkFor(source),
          points: details.points, tags: details.tags,
          ...(details.priority ? { priority: details.priority } : {}),
          notify_all: false
        }
      };
    }

    const moving = String(item.list.id) !== sprint.id;
    const restoring = item.archived === true;
    const moveOptions = { move_custom_fields: false };
    if (moving) {
      const status = list.statuses.find(value => normalize(value.status) === normalize(item.status?.status));
      if (!status?.id || !item.status?.id) {
        throw new Error(`Cannot preserve sprint item ${item.id} status "${item.status?.status}" in "${sprint.name}"`);
      }
      if (status.id !== item.status.id) {
        moveOptions.status_mappings = [{
          source_status_id: item.status.id, destination_status_id: status.id
        }];
      }
    }
    const updates = item.name === source.name ? {} : { name: source.name };
    // Scheduling (restore or move) refreshes copied details; metadata-only syncs leave sprint edits alone.
    const details = moving || restoring ? this.copiedDetails(source) : null;
    const product = this.productTags(source);
    const wantedTags = details ? details.tags : [product.current].filter(Boolean);
    if (details) {
      if (details.description !== null && !sameText(item.description, details.description)) {
        updates.description = details.description;
      }
      if (numberValue(item.points) !== details.points) updates.points = details.points;
      if (details.priority && priorityOf(item) !== details.priority) updates.priority = details.priority;
    }
    const tagsToAdd = wantedTags.filter(tag => !hasTag(item, tag));
    const tagsToRemove = (item.tags || []).map(tag => tag?.name)
      .filter(name => product.stale.some(stale => normalize(stale) === normalize(name)));
    const linkRequired = !linkedIds(item).includes(source.id);
    return {
      ...base, action: 'sync', itemId: item.id, moving, restoring, moveOptions, updates,
      expectedStatus: moving || restoring ? item.status.status : null,
      linkRequired, details, tagsToAdd, tagsToRemove,
      changed: moving || restoring || Object.keys(updates).length > 0 ||
        linkRequired || tagsToAdd.length > 0 || tagsToRemove.length > 0
    };
  }

  async apply(plan, catalog) {
    if (!plan.changed) return plan;
    let itemId = plan.itemId;
    if (plan.action === 'archive') {
      await this.clickup.updateTask(itemId, { archived: true });
    } else if (plan.action === 'create') {
      const created = await this.clickup.createTask(plan.listId, plan.create);
      if (!created?.id) throw new Error('Sprint task creation returned no task ID; inspect the sprint before retrying');
      itemId = created.id;
    } else {
      if (plan.restoring) await this.clickup.updateTask(itemId, { archived: false });
      if (plan.moving) {
        const moved = await this.clickup.moveTask(this.config.workspaceId, itemId, plan.listId, plan.moveOptions);
        if (String(moved?.new_list_id) !== plan.listId) {
          throw new Error(`Sprint item ${itemId} move did not confirm the requested List`);
        }
      }
      if (Object.keys(plan.updates).length > 0) await this.clickup.updateTask(itemId, plan.updates);
      for (const tag of plan.tagsToRemove || []) await this.clickup.removeTaskTag(itemId, tag);
      for (const tag of plan.tagsToAdd || []) await this.clickup.addTaskTag(itemId, tag);
    }
    let actual = await this.clickup.getTask(itemId);
    if (plan.action !== 'archive' && !linkedIds(actual).includes(plan.sourceId)) {
      await this.clickup.addTaskLink(itemId, plan.sourceId);
      actual = await this.clickup.getTask(itemId);
      if (!linkedIds(actual).includes(plan.sourceId)) {
        throw new Error(`Sprint item ${itemId} did not retain its native backlog task link`);
      }
    }
    if (!isManaged(actual, plan.sourceId) || String(actual.list?.id) !== plan.listId ||
        (plan.expectedStatus && normalize(actual.status?.status) !== normalize(plan.expectedStatus)) ||
        (plan.action === 'archive' ? actual.archived !== true :
          actual.archived === true || actual.name !== plan.name)) {
      throw new Error(`Sprint item ${itemId} did not retain its requested archive state/marker/List/name/status; inspect it and reconcile again`);
    }
    const missing = [];
    const missingTags = (plan.tagsToAdd || plan.details?.tags || []).filter(tag => !hasTag(actual, tag));
    if (missingTags.length > 0) missing.push(`tags ${missingTags.join(', ')}`);
    if (plan.details) {
      if (numberValue(actual.points) !== plan.details.points) missing.push(`Sprint Points ${plan.details.points}`);
      if (plan.details.priority && priorityOf(actual) !== plan.details.priority) {
        missing.push(`priority ${plan.details.priority}`);
      }
    }
    if (missing.length > 0) {
      logger.warn(`Sprint item ${itemId} did not retain ${missing.join(', ')}; ` +
        'check that the Sprint Points, Tags, and Priority ClickApps are enabled');
    }
    if (catalog.sprintTaskInventory) {
      const inventory = await catalog.sprintTaskInventory;
      const index = inventory.findIndex(item => item.id === itemId);
      if (index === -1) inventory.push(actual);
      else inventory[index] = actual;
    }
    const action = plan.action === 'archive' ? 'archived' :
      plan.action === 'create' ? 'created' : plan.restoring ? 'restored' : 'updated';
    logger.info(`Backlog task ${plan.sourceId}: ${action} linked sprint task ${itemId}`);
    return { ...plan, itemId };
  }
}

module.exports = { SprintTasks, isManaged, sourceIdOf, linkedIds };
