const { logger } = require('../utils/logger');

const fieldNames = ['Product', 'Persona'];
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isEmpty = value => value == null || value === '';
const markerFor = sourceId => `Managed backlog task ID: ${sourceId}`;

function isManaged(item, sourceId) {
  return [item.description, item.text_content].some(text =>
    typeof text === 'string' && text.split(/\r?\n/).some(line => line === markerFor(sourceId)));
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

  dropdownValue(field) {
    if (!field?.id || field.type !== 'drop_down') {
      throw new Error('Product and Persona must be accessible dropdown custom fields on both tasks');
    }
    if (isEmpty(field.value)) return null;
    const option = this.clickup.getDropdownOption(field);
    if (!option?.id) throw new Error(`Cannot resolve "${field.name}" dropdown value "${field.value}"`);
    return option.id;
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
    const [list, fields] = await Promise.all([
      this.clickup.getList(sprint.id), this.clickup.getListFields(sprint.id)
    ]);
    if (!Array.isArray(list.statuses)) throw new Error(`Sprint List ${sprint.id} has no status metadata`);
    const desiredFields = fieldNames.map(name => {
      const sourceField = this.clickup.getCustomField(source, name);
      const destination = this.clickup.getCustomField({ custom_fields: fields }, name);
      const value = this.dropdownValue(sourceField);
      if (destination?.type !== 'drop_down' || destination.id !== sourceField.id) {
        throw new Error(`Sprint "${sprint.name}" must expose the same existing "${name}" dropdown as Master Backlog`);
      }
      if (value !== null && !destination.type_config?.options?.some(option => option.id === value)) {
        throw new Error(`Sprint "${sprint.name}" is missing the selected "${name}" option`);
      }
      return { id: destination.id, name, value };
    });
    const base = {
      sourceId: source.id, listId: sprint.id, name: source.name, desiredFields
    };
    if (!item) {
      const status = list.statuses.find(value => normalize(value.status) === normalize(this.config.sprintTasks.initialStatus));
      if (!status) throw new Error(`Sprint "${sprint.name}" has no "${this.config.sprintTasks.initialStatus}" status`);
      return {
        ...base, changed: true, action: 'create', expectedStatus: status.status,
        create: {
          name: source.name, status: status.status, links_to: source.id,
          description: `Backlog task: ${source.url || `https://app.clickup.com/t/${source.id}`}\n\n${markerFor(source.id)}`,
          custom_fields: desiredFields.filter(field => field.value !== null).map(({ id, value }) => ({ id, value })),
          notify_all: false, check_required_custom_fields: true
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
    const fieldUpdates = desiredFields.filter(field => {
      const current = this.clickup.getCustomField(item, field.name);
      if (current?.id !== field.id) throw new Error(`Sprint item ${item.id} is missing the shared "${field.name}" field`);
      return this.dropdownValue(current) !== field.value;
    });
    const updates = item.name === source.name ? {} : { name: source.name };
    const linkRequired = !linkedIds(item).includes(source.id);
    return {
      ...base, action: 'sync', itemId: item.id, moving, restoring, moveOptions, updates,
      expectedStatus: moving || restoring ? item.status.status : null,
      fieldUpdates, linkRequired,
      changed: moving || restoring || fieldUpdates.length > 0 || Object.keys(updates).length > 0 || linkRequired
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
      let fieldUpdates = plan.fieldUpdates;
      if (plan.restoring) await this.clickup.updateTask(itemId, { archived: false });
      if (plan.moving) {
        const moved = await this.clickup.moveTask(this.config.workspaceId, itemId, plan.listId, plan.moveOptions);
        if (String(moved?.new_list_id) !== plan.listId) {
          throw new Error(`Sprint item ${itemId} move did not confirm the requested List`);
        }
        const movedTask = await this.clickup.getTask(itemId);
        fieldUpdates = plan.desiredFields.filter(field =>
          this.dropdownValue(this.clickup.getCustomField(movedTask, field.name)) !== field.value);
      }
      if (Object.keys(plan.updates).length > 0) await this.clickup.updateTask(itemId, plan.updates);
      for (const field of fieldUpdates) {
        if (field.value === null) await this.clickup.clearCustomFieldValue(itemId, field.id);
        else await this.clickup.setCustomFieldValue(itemId, field.id, field.value);
      }
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
          actual.archived === true || actual.name !== plan.name || plan.desiredFields.some(field =>
            this.dropdownValue(this.clickup.getCustomField(actual, field.name)) !== field.value))) {
      throw new Error(`Sprint item ${itemId} did not retain its requested archive state/marker/List/name/status/Product/Persona; inspect it and reconcile again`);
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

module.exports = { SprintTasks };
