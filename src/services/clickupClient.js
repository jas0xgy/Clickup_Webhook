const axios = require('axios');
const { logger } = require('../utils/logger');

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;

/**
 * ClickUp API client for interacting with ClickUp's API
 */
class ClickUpClient {
  constructor() {
    this.client = axios.create({
      baseURL: CLICKUP_API_BASE,
      timeout: 15000,
      headers: {
        'Authorization': CLICKUP_API_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    this.client.interceptors.response.use(undefined, error => {
      const details = error.response?.data;
      if (typeof details?.err === 'string' && details.err.trim()) {
        const code = typeof details.ECODE === 'string' ? ` (${details.ECODE})` : '';
        error.message = `${error.message}: ${details.err}${code}`;
      }
      return Promise.reject(error);
    });
  }

  /**
   * Updates task status
   * @param {string} taskId - The ClickUp task ID
   * @param {string} statusName - The status name to set (e.g., "completed", "in progress")
   * @returns {Promise<Object>} - The updated task
   */
  async updateTaskStatus(taskId, statusName) {
    try {
      logger.info(`Updating task ${taskId} status to: ${statusName}`);
      
      const task = await this.updateTask(taskId, { status: statusName });

      logger.info(`Task ${taskId} status updated successfully`);
      return task;
    } catch (error) {
      logger.error(`Failed to update task status for ${taskId}:`, error.message);
      throw error;
    }
  }

  /**
   * Gets task details
   * @param {string} taskId - The ClickUp task ID
   * @returns {Promise<Object>} - The task object
   */
  async getTask(taskId) {
    try {
      logger.info(`Fetching task ${taskId}`);
      
      const response = await this.client.get(`/task/${taskId}`);
      
      return response.data;
    } catch (error) {
      logger.error(`Failed to get task ${taskId}:`, error.message);
      throw error;
    }
  }

  async updateTask(taskId, updates) {
    const response = await this.client.put(`/task/${taskId}`, updates);
    return response.data;
  }

  async getList(listId) {
    const response = await this.client.get(`/list/${listId}`);
    return response.data;
  }

  async createList(folderId, list) {
    const response = await this.client.post(`/folder/${folderId}/list`, list);
    return response.data;
  }

  async getListFields(listId) {
    const response = await this.client.get(`/list/${listId}/field`);
    if (!Array.isArray(response.data.fields)) throw new Error('ClickUp returned invalid custom field metadata');
    return response.data.fields;
  }

  async createTask(listId, task) {
    const response = await this.client.post(`/list/${listId}/task`, task);
    return response.data;
  }

  async addTaskLink(taskId, sourceId) {
    await this.client.post(`/task/${taskId}/link/${sourceId}`);
  }

  async addTaskTag(taskId, tagName) {
    await this.client.post(`/task/${taskId}/tag/${encodeURIComponent(tagName)}`);
  }

  async addTaskComment(taskId, commentText, notifyAll = true) {
    const response = await this.client.post(`/task/${taskId}/comment`, {
      comment_text: commentText, notify_all: notifyAll
    });
    return response.data;
  }

  async removeTaskTag(taskId, tagName) {
    await this.client.delete(`/task/${taskId}/tag/${encodeURIComponent(tagName)}`);
  }

  async moveTask(workspaceId, taskId, listId, options) {
    const response = await this.client.put(
      `https://api.clickup.com/api/v3/workspaces/${workspaceId}/tasks/${taskId}/home_list/${listId}`,
      options
    );
    return response.data.data;
  }

  async getFolderLists(folderId, archived) {
    const response = await this.client.get(`/folder/${folderId}/list`, { params: { archived } });
    if (!Array.isArray(response.data.lists)) throw new Error('ClickUp returned an invalid List collection');
    return response.data.lists;
  }

  async getListTasks(listId, { archived = false } = {}) {
    const tasks = new Map();
    for (let page = 0; ; page += 1) {
      const { data } = await this.client.get(`/list/${listId}/task`, {
        params: { page, include_closed: true, subtasks: true, archived, order_by: 'id' }
      });
      if (!Array.isArray(data.tasks)) throw new Error('ClickUp returned an invalid task page');
      const previousSize = tasks.size;
      for (const task of data.tasks) {
        if (!task.id) throw new Error('ClickUp returned a task without an ID');
        tasks.set(String(task.id), task);
      }
      if (data.last_page === true || data.tasks.length === 0) break;
      if (tasks.size === previousSize) throw new Error('ClickUp task pagination stopped making progress');
    }
    return [...tasks.values()];
  }

  async setCustomFieldValue(taskId, fieldId, value) {
    try {
      const response = await this.client.post(`/task/${taskId}/field/${fieldId}`, { value });
      return response.data;
    } catch (error) {
      logger.error(`Failed to set custom field ${fieldId} on task ${taskId}:`, error.message);
      throw error;
    }
  }

  async clearCustomFieldValue(taskId, fieldId) {
    try {
      const response = await this.client.delete(`/task/${taskId}/field/${fieldId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to clear custom field ${fieldId} on task ${taskId}:`, error.message);
      throw error;
    }
  }

  getDropdownOption(field) {
    const value = field.value;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    return field.type_config?.options?.find(option =>
      option.id === value ||
      (option.orderindex != null && String(option.orderindex) === String(value))
    ) || null;
  }

  /**
   * Gets custom field value
   * @param {Object} task - The task object
   * @param {string} fieldName - The custom field name
   * @returns {Object|null} - The field object or null if not found
   */
  getCustomField(task, fieldName) {
    if (!task.custom_fields) {
      return null;
    }

    return task.custom_fields.find(
      field => typeof field.name === 'string' &&
        field.name.trim().toLowerCase() === fieldName.trim().toLowerCase()
    ) || null;
  }

  /**
   * Checks if a custom field has a truthy/completed value
   * @param {Object} field - The custom field object
   * @returns {boolean} - True if field is considered "completed"
   */
  isFieldCompleted(field) {
    if (!field) return false;

    const value = field.value;

    // Handle different field types
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'completed' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'number') return value > 0;

    return !!value;
  }
}

module.exports = { ClickUpClient };
