(function () {
  'use strict';
  var labels = { market: '市场总览', portfolio: '账户表现', holdings: '持仓收益', analysis: '持仓分析', trades: '交易计划', stocks: '个股分析', watchlist: '关注列表' };
  var dialog = document.getElementById('method-dialog');
  var lastOpener = null;
  var currentWorkspace = 'market';
  function byId(id) { return document.getElementById(id); }
  function each(selector, callback) { Array.prototype.forEach.call(document.querySelectorAll(selector), callback); }
  function showWorkspace(name) {
    if (!Object.prototype.hasOwnProperty.call(labels, name)) return;
    currentWorkspace = name;
    Object.keys(labels).forEach(function (key) { byId(key + '-page').hidden = key !== name; });
    each('.workspace-nav [data-workspace]', function (button) {
      if (button.dataset.workspace === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    byId('workspace-title').textContent = labels[name];
    window.dispatchEvent(new CustomEvent('investment-workspace-change', { detail: { workspace: name } }));
  }
  function openMethod(event) {
    if (dialog.open) return;
    lastOpener = event && event.currentTarget ? event.currentTarget : document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.classList.add('dialog-fallback'); }
    document.body.classList.add('method-open');
    byId('close-method').focus();
  }
  function restoreFocus() {
    document.body.classList.remove('method-open');
    if (lastOpener && typeof lastOpener.focus === 'function') lastOpener.focus();
    lastOpener = null;
  }
  function closeMethod() {
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.classList.remove('dialog-fallback'); }
    restoreFocus();
  }
  function reportLoadError(id, message) {
    var element = byId(id);
    if (!element) return;
    element.hidden = false;
    element.replaceChildren();
    var text = document.createElement('span');
    text.textContent = message;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新载入';
    retry.addEventListener('click', function () { window.location.reload(); });
    element.append(text, retry);
  }
  async function readSnapshot(url, label) {
    var response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(label + '暂时未能加载');
    var type = response.headers && response.headers.get('content-type');
    if (type && type.indexOf('text/html') !== -1) throw new Error('快照路径暂时不可用，请稍后重新载入');
    try { return await response.json(); }
    catch (error) { throw new Error(label + '返回内容无法读取，请重新载入'); }
  }
  each('[data-workspace]', function (button) { button.addEventListener('click', function () { showWorkspace(button.dataset.workspace); }); });
  each('[data-open-method], [data-open-market-method]', function (button) { button.addEventListener('click', openMethod); });
  byId('method-button').addEventListener('click', openMethod);
  byId('close-method').addEventListener('click', closeMethod);
  dialog.addEventListener('close', restoreFocus);
  dialog.addEventListener('cancel', function () { restoreFocus(); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMethod();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && dialog.open) { event.preventDefault(); closeMethod(); }
  });
  window.addEventListener('investment-show-portfolio', function () { showWorkspace('portfolio'); });
  byId('refresh-button').addEventListener('click', function () { window.location.reload(); });
  window.InvestmentShell = { showWorkspace: showWorkspace, getWorkspace: function () { return currentWorkspace; }, openMethod: openMethod, closeMethod: closeMethod, reportLoadError: reportLoadError, readSnapshot: readSnapshot };
}());
