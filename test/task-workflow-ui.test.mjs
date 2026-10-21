import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskWorkflow } from '../public/task-workflow.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function workspace(id, title, owner, content) {
  const documentId = `${id}-document`;
  return {
    task: { id, title, owner, dueDate: '2026-10-23', deliverable: `${title}的交付要求`, status: '进行中', submissionType: '文本', attachments: [] },
    settings: { enabled: true, baseUrl: 'https://first-model.example/v1', model: 'first-chat' },
    templates: [{ id: 'builtin-minutes', name: '会议纪要模板', content: '一、会议情况\n二、议定事项' }],
    materials: [], sourceFiles: [], submissions: [],
    documents: [{ id: documentId, title: `${title}草稿`, revision: 1, updatedAt: '2026-10-20T03:00:00Z' }],
    document: { id: documentId, title: `${title}草稿`, content, revision: 1, originalContent: content, createdAt: '2026-10-20T03:00:00Z', sources: [] }
  };
}

function fixture(t, api) {
  // These tests exercise the real workflow state without a browser or DOM library.
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } });
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
  });
  return createTaskWorkflow({
    api, esc, icon: () => '',
    action: (name, label, cls = '', extra = '') => `<button class="${cls}" data-action="${name}" ${extra}>${label}</button>`,
    option: (value, selected, label = value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`,
    timeText: value => value || '', badge: task => esc(task.status),
    toast: () => {}, rerender: () => {}, onTaskChange: async () => {},
    openTaskForm: () => {}, openRecords: () => {}, openCompletion: () => {}, navigate: () => {}
  });
}

test('返回同一任务时更新交付要求和模型目的地，同时保留未保存正文', async t => {
  const state = workspace('task-a', '项目例会', '原负责人', '已保存的会议正文。');
  let workspaceReads = 0, documentReads = 0;
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') { workspaceReads++; return structuredClone(state); }
    if (path === '/api/ai/documents/task-a-document') { documentReads++; return { document: structuredClone(state.document) }; }
    assert.fail(`不应调用接口：${path}`);
  });
  await workflow.open('task-a');
  workflow.input({ name: 'documentContent', value: '未保存的人工修改：甲负责三日内核对台账。' });
  assert.equal(workflow.hasUnsaved, true);

  // Simulate editing the task and model settings after returning to the task list.
  state.task.owner = '新负责人';
  state.task.deliverable = '新的交付要求：需补充责任人与截止日期。';
  state.settings.baseUrl = 'https://updated-model.example/v1';
  state.settings.model = 'updated-chat';
  await workflow.open('task-a');

  const html = workflow.render();
  assert.equal(workspaceReads, 2);
  assert.equal(documentReads, 1, '刷新要求不应重新读取文档并覆盖人工修改');
  assert.match(html, /负责人：新负责人/);
  assert.match(html, /新的交付要求：需补充责任人与截止日期/);
  assert.match(html, /updated-model\.example/);
  assert.match(html, /updated-chat/);
  assert.doesNotMatch(html, /原负责人|first-model\.example|first-chat/);
  assert.match(html, /<textarea[^>]*name="documentContent"[^>]*>未保存的人工修改：甲负责三日内核对台账。<\/textarea>/);
  assert.equal(workflow.hasUnsaved, true);
});

test('较早任务的文档迟到时不覆盖当前任务的草稿', async t => {
  const first = workspace('task-a', '甲任务', '甲负责人', '甲任务私有正文，不应显示在乙任务。');
  const second = workspace('task-b', '乙任务', '乙负责人', '乙任务的正确正文。');
  const firstDocumentRequested = deferred(), firstDocumentResponse = deferred();
  const workflow = fixture(t, async path => {
    if (path === '/api/tasks/task-a/workspace') return structuredClone(first);
    if (path === '/api/tasks/task-b/workspace') return structuredClone(second);
    if (path === '/api/ai/documents/task-a-document') {
      firstDocumentRequested.resolve();
      return firstDocumentResponse.promise;
    }
    if (path === '/api/ai/documents/task-b-document') return { document: structuredClone(second.document) };
    assert.fail(`不应调用接口：${path}`);
  });

  const firstOpening = workflow.open('task-a');
  await firstDocumentRequested.promise;
  await workflow.open('task-b');
  assert.match(workflow.render(), /乙任务的正确正文/);

  firstDocumentResponse.resolve({ document: structuredClone(first.document) });
  await firstOpening;

  const html = workflow.render();
  assert.equal(workflow.taskId, 'task-b');
  assert.match(html, /<h1>乙任务<\/h1>/);
  assert.match(html, /负责人：乙负责人/);
  assert.match(html, /value="乙任务草稿"/);
  assert.match(html, /<textarea[^>]*name="documentContent"[^>]*>乙任务的正确正文。<\/textarea>/);
  assert.doesNotMatch(html, /甲任务|甲负责人|甲任务私有正文/);
  assert.equal(workflow.hasUnsaved, false);
});
