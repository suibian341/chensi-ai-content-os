const selectInstances = new Set();
const dialogReturnFocus = new WeakMap();
const dialogStack = [];
let openSelect = null;
let selectSequence = 0;
let currentAction = null;

function selectLabel(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const explicit = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
  const label = explicit || select.closest('label');
  const labelText = label?.querySelector(':scope > span')?.textContent?.trim() || label?.textContent?.trim();
  return labelText || select.name || '选择选项';
}

function visibleOptions(instance) {
  return instance.options.filter((item) => !item.button.hidden && !item.option.disabled);
}

function setHighlighted(instance, optionIndex, scroll = true) {
  instance.highlightedIndex = optionIndex;
  for (const item of instance.options) {
    const active = item.index === optionIndex;
    item.button.classList.toggle('is-highlighted', active);
    if (active) instance.trigger.setAttribute('aria-activedescendant', item.button.id);
  }
  const active = instance.options.find((item) => item.index === optionIndex)?.button;
  if (active && scroll) active.scrollIntoView({ block: 'nearest' });
}

function positionSelect(instance) {
  if (!instance || instance !== openSelect || instance.popover.classList.contains('hidden')) return;
  const rect = instance.trigger.getBoundingClientRect();
  const viewportGap = 8;
  const width = Math.min(Math.max(rect.width, 220), window.innerWidth - viewportGap * 2);
  instance.popover.style.width = `${width}px`;
  const naturalHeight = Math.min(instance.popover.scrollHeight, 330);
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  const placeAbove = below < Math.min(190, naturalHeight) && above > below;
  const maxHeight = Math.max(132, Math.min(330, placeAbove ? above : below));
  const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap);
  const top = placeAbove ? Math.max(viewportGap, rect.top - Math.min(naturalHeight, maxHeight) - 7) : rect.bottom + 7;
  instance.popover.style.left = `${Math.round(left)}px`;
  instance.popover.style.top = `${Math.round(top)}px`;
  instance.popover.style.setProperty('--ui-select-max-height', `${Math.floor(maxHeight)}px`);
  instance.popover.dataset.placement = placeAbove ? 'top' : 'bottom';
}

function closeSelect(instance = openSelect, { restoreFocus = false } = {}) {
  if (!instance) return;
  instance.popover.classList.add('hidden');
  instance.trigger.classList.remove('is-open');
  instance.trigger.setAttribute('aria-expanded', 'false');
  instance.trigger.removeAttribute('aria-activedescendant');
  instance.search.value = '';
  instance.filter('');
  if (openSelect === instance) openSelect = null;
  if (restoreFocus) instance.trigger.focus({ preventScroll: true });
}

function openSelectMenu(instance, direction = 1) {
  if (instance.select.disabled) return;
  if (openSelect && openSelect !== instance) closeSelect(openSelect);
  instance.refresh();
  instance.filter('');
  instance.popover.classList.remove('hidden');
  instance.trigger.classList.add('is-open');
  instance.trigger.setAttribute('aria-expanded', 'true');
  openSelect = instance;
  const selected = instance.select.selectedIndex;
  const fallback = visibleOptions(instance)[direction < 0 ? visibleOptions(instance).length - 1 : 0]?.index ?? 0;
  setHighlighted(instance, selected >= 0 ? selected : fallback, false);
  positionSelect(instance);
  requestAnimationFrame(() => {
    positionSelect(instance);
    setHighlighted(instance, instance.highlightedIndex);
  });
}

function moveHighlight(instance, delta) {
  const items = visibleOptions(instance);
  if (!items.length) return;
  const current = items.findIndex((item) => item.index === instance.highlightedIndex);
  const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
  setHighlighted(instance, items[next].index);
}

function chooseOption(instance, index) {
  const item = instance.options.find((candidate) => candidate.index === index);
  if (!item || item.option.disabled) return;
  instance.select.selectedIndex = index;
  instance.select.dispatchEvent(new Event('change', { bubbles: true }));
  instance.refresh();
  closeSelect(instance, { restoreFocus: true });
}

function buildSelectOptions(instance) {
  instance.list.replaceChildren();
  instance.options = [...instance.select.options].map((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-select-option';
    button.id = `${instance.id}-option-${index}`;
    button.setAttribute('role', 'option');
    button.dataset.optionIndex = String(index);
    button.disabled = option.disabled;

    const text = document.createElement('span');
    text.className = 'ui-select-option-label';
    text.textContent = option.label || option.textContent;
    const check = document.createElement('span');
    check.className = 'ui-select-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    button.append(text, check);
    instance.list.append(button);
    return { option, button, index, searchText: text.textContent.toLocaleLowerCase('zh-CN') };
  });
  const searchable = instance.options.length >= 8 || instance.select.dataset.searchable === 'true';
  instance.searchWrap.classList.toggle('hidden', !searchable);
}

function upgradeSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple || select.dataset.uiSelectReady) return;
  select.dataset.uiSelectReady = 'true';
  select.classList.add('ui-native-select');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const id = `ui-select-${++selectSequence}`;
  const wrapper = document.createElement('div');
  wrapper.className = `ui-select${select.classList.contains('project-select') ? ' ui-project-select' : ''}`;
  wrapper.dataset.selectFor = select.id || id;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.id = `${id}-trigger`;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', selectLabel(select));
  trigger.setAttribute('aria-controls', `${id}-listbox`);

  const value = document.createElement('span');
  value.className = 'ui-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'ui-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  wrapper.append(trigger);
  select.insertAdjacentElement('afterend', wrapper);

  const popover = document.createElement('div');
  popover.className = 'ui-select-popover hidden';
  popover.dataset.uiSelectOwner = id;
  const parentDialog = select.closest('.modal-backdrop');
  if (parentDialog?.id) popover.dataset.dialogId = parentDialog.id;

  const searchWrap = document.createElement('label');
  searchWrap.className = 'ui-select-search-wrap hidden';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ui-select-search';
  search.placeholder = '搜索选项';
  search.setAttribute('aria-label', `搜索${selectLabel(select)}`);
  searchWrap.append(search);

  const list = document.createElement('div');
  list.className = 'ui-select-list';
  list.id = `${id}-listbox`;
  list.setAttribute('role', 'listbox');
  popover.append(searchWrap, list);
  document.body.append(popover);

  const instance = {
    id, select, wrapper, trigger, value, popover, searchWrap, search, list,
    options: [], highlightedIndex: -1, signature: '', typeahead: '', typeaheadTimer: 0,
    filter(query) {
      const normalized = query.trim().toLocaleLowerCase('zh-CN');
      let firstVisible = -1;
      for (const item of this.options) {
        const visible = !normalized || item.searchText.includes(normalized);
        item.button.hidden = !visible;
        if (visible && !item.option.disabled && firstVisible < 0) firstVisible = item.index;
      }
      this.list.classList.toggle('is-empty', firstVisible < 0);
      if (firstVisible >= 0 && !visibleOptions(this).some((item) => item.index === this.highlightedIndex)) setHighlighted(this, firstVisible, false);
      positionSelect(this);
    },
    refresh(force = false) {
      const signature = [...this.select.options].map((option) => `${option.value}:${option.label}:${option.disabled}`).join('|');
      if (force || signature !== this.signature) {
        this.signature = signature;
        buildSelectOptions(this);
      }
      const selected = this.select.selectedOptions[0] || this.select.options[0];
      this.value.textContent = selected?.label || selected?.textContent || '请选择';
      this.trigger.disabled = this.select.disabled;
      this.wrapper.classList.toggle('is-disabled', this.select.disabled);
      this.wrapper.classList.toggle('is-empty', !this.select.value);
      for (const item of this.options) {
        const active = item.index === this.select.selectedIndex;
        item.button.classList.toggle('is-selected', active);
        item.button.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (this === openSelect) positionSelect(this);
    }
  };

  trigger.addEventListener('click', () => openSelect === instance ? closeSelect(instance) : openSelectMenu(instance));
  trigger.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (openSelect !== instance) openSelectMenu(instance, event.key === 'ArrowUp' ? -1 : 1);
      else moveHighlight(instance, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' && openSelect === instance) { event.preventDefault(); setHighlighted(instance, visibleOptions(instance)[0]?.index ?? 0); return; }
    if (event.key === 'End' && openSelect === instance) { event.preventDefault(); const items = visibleOptions(instance); setHighlighted(instance, items.at(-1)?.index ?? 0); return; }
    if ((event.key === 'Enter' || event.key === ' ') && openSelect === instance) { event.preventDefault(); chooseOption(instance, instance.highlightedIndex); return; }
    if (event.key === 'Escape' && openSelect === instance) { event.preventDefault(); event.stopPropagation(); closeSelect(instance); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      instance.typeahead += event.key.toLocaleLowerCase('zh-CN');
      clearTimeout(instance.typeaheadTimer);
      instance.typeaheadTimer = setTimeout(() => { instance.typeahead = ''; }, 700);
      const match = instance.options.find((item) => !item.option.disabled && item.searchText.startsWith(instance.typeahead));
      if (match) {
        if (openSelect === instance) setHighlighted(instance, match.index);
        else chooseOption(instance, match.index);
      }
    }
  });
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-option-index]');
    if (option) chooseOption(instance, Number(option.dataset.optionIndex));
  });
  list.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[data-option-index]');
    if (option && !option.disabled) setHighlighted(instance, Number(option.dataset.optionIndex), false);
  });
  search.addEventListener('input', () => instance.filter(search.value));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveHighlight(instance, event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter') { event.preventDefault(); chooseOption(instance, instance.highlightedIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSelect(instance, { restoreFocus: true }); }
  });
  select.addEventListener('change', () => instance.refresh());
  select.addEventListener('click', (event) => {
    event.preventDefault();
    trigger.focus({ preventScroll: true });
    if (openSelect !== instance) openSelectMenu(instance);
  });
  select.addEventListener('invalid', (event) => { event.preventDefault(); trigger.focus(); trigger.classList.add('is-invalid'); });
  trigger.addEventListener('focus', () => trigger.classList.remove('is-invalid'));

  const optionObserver = new MutationObserver(() => queueMicrotask(() => instance.refresh(true)));
  optionObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label', 'value', 'selected'] });
  instance.observer = optionObserver;
  instance.refresh(true);
  selectInstances.add(instance);
}

function upgradeSelects(root = document) {
  if (root instanceof HTMLSelectElement) upgradeSelect(root);
  root.querySelectorAll?.('select').forEach(upgradeSelect);
}

function cleanupSelects() {
  for (const instance of selectInstances) {
    if (instance.select.isConnected) continue;
    if (openSelect === instance) closeSelect(instance);
    instance.observer.disconnect();
    instance.popover.remove();
    selectInstances.delete(instance);
  }
}

function focusables(dialog) {
  const selector = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = [...dialog.querySelectorAll(selector)].filter((node) => !node.closest('.hidden'));
  if (dialog.id) {
    document.querySelectorAll(`.ui-select-popover[data-dialog-id="${CSS.escape(dialog.id)}"]:not(.hidden)`).forEach((popover) => {
      nodes.push(...popover.querySelectorAll(selector));
    });
  }
  return nodes.filter((node) => node.getClientRects().length);
}

function openDialog(dialog, { initialFocus = null, returnFocus = document.activeElement } = {}) {
  if (!dialog) return;
  closeSelect();
  dialogReturnFocus.set(dialog, returnFocus instanceof HTMLElement ? returnFocus : null);
  dialog.classList.remove('hidden');
  dialog.setAttribute('aria-hidden', 'false');
  if (!dialogStack.includes(dialog)) dialogStack.push(dialog);
  document.body.classList.add('dialog-open');
  requestAnimationFrame(() => {
    const target = initialFocus ? dialog.querySelector(initialFocus) : focusables(dialog)[0];
    target?.focus({ preventScroll: true });
  });
}

function closeDialog(dialog, { restoreFocus = true } = {}) {
  if (!dialog) return;
  closeSelect();
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
  const index = dialogStack.lastIndexOf(dialog);
  if (index >= 0) dialogStack.splice(index, 1);
  if (!dialogStack.length) document.body.classList.remove('dialog-open');
  const target = dialogReturnFocus.get(dialog);
  if (restoreFocus && target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

function ensureActionDialog() {
  let backdrop = document.querySelector('#uiActionDialog');
  if (backdrop) return backdrop;
  backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop hidden ui-action-backdrop';
  backdrop.id = 'uiActionDialog';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'uiActionDialogTitle');
  backdrop.setAttribute('aria-describedby', 'uiActionDialogMessage');
  backdrop.innerHTML = `
    <form class="modal ui-action-dialog" id="uiActionDialogForm" novalidate>
      <div class="modal-header">
        <div class="ui-dialog-heading"><span class="ui-dialog-symbol" aria-hidden="true">!</span><div><div class="section-kicker" id="uiActionDialogKicker">请确认操作</div><h2 id="uiActionDialogTitle">确认操作</h2></div></div>
        <button class="icon-button ui-dialog-close" type="button" data-dialog-cancel aria-label="关闭">×</button>
      </div>
      <p class="ui-dialog-message" id="uiActionDialogMessage"></p>
      <div class="ui-dialog-fields" id="uiActionDialogFields"></div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-dialog-cancel>取消</button>
        <button class="primary-button" id="uiActionDialogConfirm" type="submit">确认</button>
      </div>
    </form>`;
  document.body.append(backdrop);

  const cancel = () => {
    if (!currentAction) return;
    const resolve = currentAction.resolve;
    currentAction = null;
    closeDialog(backdrop);
    resolve(null);
  };
  backdrop.querySelectorAll('[data-dialog-cancel]').forEach((button) => button.addEventListener('click', cancel));
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) cancel(); });
  backdrop.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!currentAction) return;
    const values = {};
    let firstInvalid = null;
    for (const field of currentAction.fields) {
      const input = backdrop.querySelector(`[name="${CSS.escape(field.name)}"]`);
      const error = input.closest('.ui-dialog-field').querySelector('.ui-dialog-field-error');
      let message = '';
      const value = input.value.trim();
      if (field.required && !value) message = field.requiredMessage || '请填写此项';
      if (!message && field.type === 'number' && (!Number.isFinite(input.valueAsNumber) || (field.integer && !Number.isInteger(input.valueAsNumber)))) message = field.invalidMessage || '请输入有效数字';
      if (!message && field.minLength && value.length < field.minLength) message = field.invalidMessage || `至少输入 ${field.minLength} 个字符`;
      if (!message && field.validate) message = field.validate(value, input) || '';
      input.toggleAttribute('aria-invalid', Boolean(message));
      error.textContent = message;
      if (message && !firstInvalid) firstInvalid = input;
      values[field.name] = field.type === 'number' ? input.valueAsNumber : value;
    }
    if (firstInvalid) { firstInvalid.focus(); return; }
    const resolve = currentAction.resolve;
    currentAction = null;
    closeDialog(backdrop);
    resolve(values);
  });
  return backdrop;
}

function askDialog(options = {}) {
  const backdrop = ensureActionDialog();
  if (currentAction) currentAction.resolve(null);
  const fields = options.fields || [];
  const form = backdrop.querySelector('form');
  const confirmButton = backdrop.querySelector('#uiActionDialogConfirm');
  const fieldsNode = backdrop.querySelector('#uiActionDialogFields');
  backdrop.querySelector('#uiActionDialogKicker').textContent = options.kicker || (options.tone === 'danger' ? '不可撤销操作' : '确认操作');
  backdrop.querySelector('#uiActionDialogTitle').textContent = options.title || '确认操作';
  backdrop.querySelector('#uiActionDialogMessage').textContent = options.message || '';
  confirmButton.textContent = options.confirmText || '确认';
  form.classList.toggle('is-danger', options.tone === 'danger');
  confirmButton.className = options.tone === 'danger' ? 'danger-button' : 'primary-button';
  fieldsNode.replaceChildren();

  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'ui-dialog-field field';
    const caption = document.createElement('span');
    caption.textContent = field.label;
    const input = document.createElement(field.multiline ? 'textarea' : 'input');
    if (!field.multiline) input.type = field.type || 'text';
    input.name = field.name;
    input.value = field.value ?? '';
    input.placeholder = field.placeholder || '';
    input.autocomplete = field.autocomplete || 'off';
    if (field.min != null) input.min = String(field.min);
    if (field.max != null) input.max = String(field.max);
    if (field.step != null) input.step = String(field.step);
    const error = document.createElement('small');
    error.className = 'ui-dialog-field-error';
    error.setAttribute('aria-live', 'polite');
    label.append(caption, input, error);
    fieldsNode.append(label);
  }

  return new Promise((resolve) => {
    currentAction = { resolve, fields };
    const focusSelector = fields.length ? `[name="${CSS.escape(fields[0].name)}"]` : '[data-dialog-cancel]';
    openDialog(backdrop, { initialFocus: options.initialFocus || focusSelector, returnFocus: options.returnFocus || document.activeElement });
  });
}

document.addEventListener('pointerdown', (event) => {
  if (openSelect && !openSelect.wrapper.contains(event.target) && !openSelect.popover.contains(event.target)) closeSelect(openSelect);
});
document.addEventListener('keydown', (event) => {
  const dialog = dialogStack.at(-1);
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const cancel = dialog.querySelector('[data-dialog-cancel], [data-dialog-close]');
    cancel?.click();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables(dialog);
  if (!items.length) return;
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
window.addEventListener('resize', () => positionSelect(openSelect));
window.addEventListener('scroll', () => positionSelect(openSelect), true);
document.addEventListener('reset', (event) => requestAnimationFrame(() => event.target.querySelectorAll('select').forEach((select) => window.uiSelect.refresh(select))));

upgradeSelects();
const selectTreeObserver = new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) upgradeSelects(node);
  cleanupSelects();
});
selectTreeObserver.observe(document.body, { childList: true, subtree: true });

window.uiSelect = {
  refresh(select) {
    const instance = [...selectInstances].find((item) => item.select === select);
    instance?.refresh(true);
  },
  refreshAll() { selectInstances.forEach((instance) => instance.refresh(true)); },
  close: closeSelect
};

window.uiDialog = {
  open: openDialog,
  close: closeDialog,
  ask: askDialog,
  async confirm(options) { return Boolean(await askDialog(options)); }
};
