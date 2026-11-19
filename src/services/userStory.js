const { logger } = require('../utils/logger');

const storyFields = ['Persona', 'Goal', 'Benefit', 'Success'];
const start = 'User Story (managed)';
const end = 'End User Story (managed)';
const normalize = text => text.replace(/\r\n/g, '\n').trim().replace(/\s+/g, ' ');

function storyValue(clickup, field) {
  if (field?.value == null || field.value === '') return '';
  if (field.type === 'drop_down') return clickup.getDropdownOption(field)?.name?.trim() || '';
  return typeof field.value === 'string' ? field.value.trim() : '';
}

function section(text, block, legacy) {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => line.trim() === start ? [i] : []);
  const ends = lines.flatMap((line, i) => line.trim() === end ? [i] : []);
  if (!starts.length && !ends.length) {
    if (!text.trim()) return { next: block, issue: 'missing-story-section' };
    if (normalize(text) === normalize(legacy)) return { next: block, legacy: true };
    return { next: `${text.trimEnd()}\n\n${block}`, issue: 'missing-story-section' };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    return { issue: 'ambiguous-story-section' };
  }
  if (normalize(lines.slice(starts[0], ends[0] + 1).join('\n')) === normalize(block)) return {};
  return {
    next: [...lines.slice(0, starts[0]), block, ...lines.slice(ends[0] + 1)].join('\n'),
    issue: 'stale-story-section'
  };
}

function planUserStory(clickup, task) {
  const fields = storyFields.map(name => clickup.getCustomField(task, name));
  if (fields.every(field => !field)) return {};
  const values = fields.map(field => storyValue(clickup, field));
  const missing = storyFields.filter((_, i) => !fields[i]?.id || !values[i]);
  if (missing.length) return { issue: 'incomplete-story-inputs', fields: missing };

  const clean = text => text.replace(/\s+/g, ' ');
  const sentence = text => /[.!?]$/.test(text) ? text : `${text}.`;
  const [persona, goal, benefit, success] = values.map(clean);
  const body = [sentence(`${persona} ${goal} ${benefit}`), sentence(`Success is when ${success}`)];
  const legacy = `${values[0]} ${values[1]} ${values[2]}.\nSuccess is when ${values[3]}.`;
  const plain = task.description || task.text_content || '';
  const plan = section(plain, [start, ...body, end].join('\n'), legacy);
  if (!plan.next) return plan;

  if (!plain.trim() && !task.markdown_description?.trim()) return { ...plan, updates: { description: plan.next } };
  if (typeof task.markdown_description !== 'string' || !task.markdown_description.trim()) {
    return { ...plan, blocked: 'story-description-format-unavailable' };
  }
  const escapeMarkdown = text => text.replace(/[\\`*_{}\[\]<>~|]/g, '\\$&');
  const markdown = section(task.markdown_description, [start, ...body.map(escapeMarkdown), end].join('\n\n'), legacy);
  if (!markdown.next) return { issue: 'ambiguous-story-section' };
  return { ...plan, updates: { markdown_description: markdown.next } };
}

async function ensureUserStory(clickup, task, backlogListId) {
  if (String(task.list?.id) !== backlogListId || task.archived) return { outcome: 'skipped' };
  const plan = planUserStory(clickup, task);
  if (!plan.updates) {
    const reason = plan.blocked || plan.issue;
    if (reason) logger.warn(`Task ${task.id}: ${reason}`, plan.fields || '');
    return reason ? { outcome: 'skipped', reason } : { outcome: 'unchanged' };
  }
  const updated = await clickup.updateTask(task.id, plan.updates);
  task.description = updated?.description ?? plan.next;
  task.markdown_description = updated?.markdown_description ?? plan.updates.markdown_description;
  logger.info(`Task ${task.id}: updated managed User Story`);
  return { outcome: 'applied' };
}

module.exports = { storyFields, planUserStory, ensureUserStory };
