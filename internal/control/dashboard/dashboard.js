(() => {
  'use strict';
  const state = {
    csrf: '',
    items: [],
    lastGood: null,
    selected: null,
    delivery: null,
    connected: false,
    requestGeneration: 0,
    pendingKeys: new Map(),
    dialogTrigger: null,
    restoreSelector: '',
    selectedCardId: '',
    nextPageToken: '',
    anomalyFilter: 'all',
  };
  const byId = (id) => document.getElementById(id);
  const live = (message) => {
    byId('command-outcome').textContent = message;
    byId('live').textContent = '';
    window.setTimeout(() => { byId('live').textContent = message; }, 20);
  };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const formatTime = (value) => value ? new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date(value)) : '—';
  const commandKey = (scope) => {
    if (!state.pendingKeys.has(scope)) state.pendingKeys.set(scope, crypto.randomUUID());
    return state.pendingKeys.get(scope);
  };
  const clearCommandKey = (scope) => state.pendingKeys.delete(scope);
  const outcomeText = (body) => {
    const outcome = body?.outcome;
    if (!outcome) return '';
    const recoverability = outcome.recoverability ? ` / 復旧: ${outcome.recoverability}` : '';
    return `${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}${recoverability}`;
  };
  const showDialogError = (id, error) => {
    const summary = byId(id);
    const structured = outcomeText(error.body);
    summary.textContent = `${error.message}${structured ? ` / outcome: ${structured}` : ''}`;
    summary.hidden = false;
    summary.focus();
  };
  const rememberDialogTrigger = () => {
    state.dialogTrigger = document.activeElement;
    state.restoreSelector = '';
  };
  const restoreDialogFocus = () => {
    const target = (state.restoreSelector && document.querySelector(state.restoreSelector))
      || (state.dialogTrigger && document.contains(state.dialogTrigger) ? state.dialogTrigger : null);
    state.restoreSelector = '';
    state.dialogTrigger = null;
    target?.focus();
  };
  const disableOperationalControls = () => {
    byId('create').disabled = true;
    byId('load-more').disabled = true;
    byId('save-registration').disabled = true;
    byId('confirm-dialog').querySelector('.danger').disabled = true;
    byId('retry-delivery').disabled = true;
  };
  const markDisconnected = (error) => {
    state.connected = false;
    state.lastGood = error.body?.error?.lastSuccessfulAt || state.lastGood;
    disableOperationalControls();
    byId('alert').hidden = false;
    byId('alert').textContent = `Control API に接続できません。表示中の値は最終正常取得 ${formatTime(state.lastGood)} のものです。`;
    byId('freshness').textContent = `切断 · 最終正常 ${formatTime(state.lastGood)}`;
    render();
  };
  const markSessionUnavailable = () => {
    state.connected = false;
    state.csrf = '';
    disableOperationalControls();
    byId('alert').hidden = false;
    byId('alert').textContent = 'Operator session が失効または拒否されました。新しい一回限りの bootstrap URL が必要です。';
    byId('freshness').textContent = 'Operator session 失効';
    render();
  };
  const handleOperationalFailure = (error) => {
    if (error.status === 401) {
      markSessionUnavailable();
      return true;
    }
    if (['control_store_unavailable', 'request_failed'].includes(error.code)) {
      markDisconnected(error);
      return true;
    }
    return false;
  };

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body) headers.set('Content-Type', 'application/json');
    if (options.method && !['GET', 'HEAD'].includes(options.method)) {
      headers.set('X-CSRF-Token', state.csrf);
    }
    let response;
    try {
      response = await fetch(path, {
        ...options, headers, credentials: 'same-origin', redirect: 'error',
      });
    } catch (cause) {
      const error = new Error('Control API network request failed', { cause });
      error.code = 'request_failed';
      error.status = 0;
      error.body = {};
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || `Control API ${response.status}`);
      error.code = body.error?.code || 'request_failed';
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  async function statusPage(path) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await api(path);
      } catch (error) {
        lastError = error;
        if (!['control_store_unavailable', 'request_failed'].includes(error.code)
          || attempt === 2) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function componentClass(component) {
    if (component.freshness !== 'fresh' || ['failed', 'disconnected', 'unknown'].includes(component.actual)) return 'bad';
    if (component.recoveryState && !['none', 'recovered'].includes(component.recoveryState)) return 'warn';
    return '';
  }
  function componentDiverges(name, component) {
    const desiredStates = {
      issue_monitor: ['starting', 'running'],
      pr_monitor: ['starting', 'running'],
      forwarder: ['starting', 'running'],
      execution: ['running', 'waiting', 'idle', 'paused_by_mode'],
      queue: ['idle', 'queued', 'leased', 'blocked_by_mode'],
    };
    const stoppedStates = {
      issue_monitor: ['stopped'],
      pr_monitor: ['stopped'],
      forwarder: ['stopped'],
      execution: ['stopped', 'idle'],
      queue: ['idle'],
    };
    const allowed = component.desired ? desiredStates[name] : stoppedStates[name];
    return !allowed?.includes(component.actual);
  }
  function isAnomaly(item) {
    return Object.entries(item.components).some(([name, component]) =>
      component.freshness !== 'fresh'
      || ['failed', 'disconnected', 'unknown'].includes(component.actual)
      || componentDiverges(name, component));
  }
  function anomalyKinds(item) {
    const components = Object.entries(item.components);
    const kinds = new Set();
    if (components.some(([, component]) => component.actual === 'failed')) kinds.add('failed');
    if (components.some(([, component]) => component.actual === 'disconnected')) kinds.add('disconnected');
    if (components.some(([, component]) => component.freshness === 'stale')) kinds.add('stale');
    if (components.some(([name, component]) => {
      if (component.actual === 'unknown') return true;
      if (['failed', 'disconnected'].includes(component.actual)) return false;
      return componentDiverges(name, component);
    })) kinds.add('divergent');
    return kinds;
  }
  function component(name, value) {
    const label = {
      issue_monitor: 'Issue Monitor', pr_monitor: 'PR Monitor', forwarder: 'Forwarder',
      execution: 'Execution', queue: 'Queue',
    }[name] || name;
    return `<section class="component" aria-label="${escapeHTML(label)}">
      <p class="component-name">${escapeHTML(label)}</p>
      <div class="state-line">
        <span class="desired">desired: ${value.desired ? 'ON' : 'OFF'}</span>
        <span class="badge ${componentClass(value)}">${escapeHTML(value.actual)}</span>
      </div>
      <dl>
        <dt>鮮度</dt><dd>${escapeHTML(value.freshness)}</dd>
        <dt>観測</dt><dd>${formatTime(value.observedAt)}</dd>
        <dt>最終正常</dt><dd>${formatTime(value.lastGoodAt)}</dd>
        <dt>復旧</dt><dd>${escapeHTML(value.recoveryState || 'none')}</dd>
        <dt>理由</dt><dd>${escapeHTML(value.staleReason || value.lastError || '—')}</dd>
      </dl>
    </section>`;
  }
  function card(item) {
    const r = item.registration;
    const components = ['issue_monitor', 'pr_monitor', 'forwarder', 'execution', 'queue']
      .map((name) => component(name, item.components[name] || {
        desired: false, actual: 'unknown', freshness: 'unknown', recoveryState: 'unknown',
      })).join('');
    const deliveries = (item.recentDeliveryFailures || []).map((failure) =>
      `<li><span>${escapeHTML(failure.event)} · ${escapeHTML(failure.status)} · attempts ${Number(failure.routeAttempts || 0)}</span>
        <button class="ghost" type="button" data-delivery="${escapeHTML(failure.id)}" ${state.connected ? '' : 'disabled'}>確認${failure.status === 'failed' ? '・再試行' : ''}</button></li>`).join('');
    return `<article class="card ${isAnomaly(item) ? 'anomaly' : ''} ${state.selectedCardId === r.id ? 'selected' : ''}" data-id="${escapeHTML(r.id)}">
      <header class="card-head">
        <div>
          <h3><button class="card-title" type="button" data-select="${escapeHTML(r.id)}" aria-label="${escapeHTML(r.repository)} の状態詳細を選択">${escapeHTML(r.repository)}</button></h3>
          <span class="quiet">version ${r.version} · ${r.enabled ? 'enabled' : 'disabled'} · ${escapeHTML(item.mode)}</span>
        </div>
        <div class="card-actions">
          <button class="ghost" type="button" data-edit="${escapeHTML(r.id)}" ${state.connected ? '' : 'disabled'}>編集</button>
          <button class="danger" type="button" data-disable="${escapeHTML(r.id)}" ${r.enabled && state.connected ? '' : 'disabled'}>無効化</button>
        </div>
      </header>
      <div class="components">${components}</div>
      <details class="details">
        <summary>配送・ジョブ詳細</summary>
        <div class="details-grid">
          <span>Issue poll<br><strong>${formatTime(item.lastPoll?.issue)}</strong></span>
          <span>PR poll<br><strong>${formatTime(item.lastPoll?.pull_request)}</strong></span>
          <span>Last delivery<br><strong>${formatTime(item.lastDelivery)}</strong></span>
          <span>Queue depth<br><strong>${Number(item.queueDepth || 0)}</strong></span>
          <span>Active job<br><strong>${escapeHTML(item.activeJobId || '—')} / ${escapeHTML(item.activeJobState || '—')} / version ${escapeHTML(item.activeJobRegistrationVersion || '—')}</strong></span>
          <span>Last error<br><strong>${escapeHTML(item.lastJobFailure?.lastError || '—')}</strong></span>
          <ul class="delivery-list" aria-label="最近の配送失敗">${deliveries || '<li>配送失敗はありません</li>'}</ul>
        </div>
      </details>
    </article>`;
  }
  function render() {
    const query = byId('search').value.trim().toLowerCase();
    const matchingRepository = state.items.filter((item) =>
      item.registration.repository.includes(query));
    const counts = {
      all: matchingRepository.length,
      failed: 0,
      disconnected: 0,
      stale: 0,
      divergent: 0,
    };
    matchingRepository.forEach((item) => {
      anomalyKinds(item).forEach((kind) => { counts[kind] += 1; });
    });
    Object.entries(counts).forEach(([kind, count]) => {
      byId('anomaly-filters').querySelector(`[data-filter-count="${kind}"]`).textContent = count;
    });
    const items = matchingRepository.filter((item) =>
      state.anomalyFilter === 'all' || anomalyKinds(item).has(state.anomalyFilter));
    byId('cards').innerHTML = items.map(card).join('');
    byId('empty').hidden = items.length !== 0;
    byId('count').textContent = `${items.length} 件`;
  }

  async function load({ announce = true } = {}) {
    const generation = ++state.requestGeneration;
    byId('refresh').disabled = true;
    byId('cards').setAttribute('aria-busy', 'true');
    byId('freshness').textContent = '取得中';
    try {
      const page = await statusPage('/v1/registrations?limit=200');
      if (generation !== state.requestGeneration) return page;
      state.items = page.items || [];
      state.nextPageToken = page.nextPageToken || '';
      state.connected = true;
      state.lastGood = page.lastSuccessfulAt || page.observedAt;
      byId('mode').textContent = page.mode;
      byId('freshness').textContent = `最終取得 ${formatTime(state.lastGood)}`;
      byId('alert').hidden = true;
      byId('create').disabled = false;
      byId('load-more').hidden = !state.nextPageToken;
      byId('load-more').disabled = false;
      render();
      if (announce) live(`${state.items.length} 件の Registration を取得しました`);
      return page;
    } catch (error) {
      if (generation !== state.requestGeneration) throw error;
      if (error.status === 401) {
        markSessionUnavailable();
        live(`Operator session 拒否: ${error.message}`);
      } else if (error.code === 'control_store_unavailable' || error.code === 'request_failed') {
        markDisconnected(error);
        live(`Control API 接続失敗: ${error.message}`);
      } else {
        byId('alert').hidden = false;
        byId('alert').textContent = `状態取得要求が拒否されました (${error.code})。入力またはsnapshotを再取得してください。`;
        live(`状態取得要求拒否: ${error.message}`);
      }
      throw error;
    } finally {
      if (generation === state.requestGeneration) {
        byId('refresh').disabled = false;
        byId('cards').setAttribute('aria-busy', 'false');
      }
    }
  }

  async function loadMore() {
    const token = state.nextPageToken;
    const generation = state.requestGeneration;
    if (!token) return;
    byId('load-more').disabled = true;
    byId('cards').setAttribute('aria-busy', 'true');
    try {
      const page = await statusPage(`/v1/registrations?limit=200&pageToken=${encodeURIComponent(token)}`);
      if (generation !== state.requestGeneration) return;
      state.items = [...state.items, ...(page.items || [])];
      state.nextPageToken = page.nextPageToken || '';
      byId('load-more').hidden = !state.nextPageToken;
      render();
      byId('load-more').focus();
      live(`${page.items?.length || 0} 件を追加し、合計 ${state.items.length} 件になりました`);
    } catch (error) {
      if (error.status === 401) {
        markSessionUnavailable();
      } else if (error.code === 'control_store_unavailable' || error.code === 'request_failed') {
        markDisconnected(error);
        byId('alert').textContent = `追加ページを確認できませんでした。表示中の値は最終正常取得 ${formatTime(state.lastGood)} のものです。`;
      } else {
        state.nextPageToken = '';
        byId('load-more').hidden = true;
        byId('alert').hidden = false;
        byId('alert').textContent = 'ページsnapshotが失効または拒否されました。「再取得」で先頭から読み直してください。';
      }
      live(`追加ページ取得失敗 (${error.code}): ${error.message}`);
    } finally {
      byId('cards').setAttribute('aria-busy', 'false');
      if (state.connected && state.nextPageToken) byId('load-more').disabled = false;
    }
  }

  function openRegistration(registration = null) {
    rememberDialogTrigger();
    state.selected = registration;
    byId('registration-error').hidden = true;
    byId('registration-reload').hidden = true;
    byId('save-registration').disabled = false;
    byId('registration-title').textContent = registration ? 'Registration を更新' : 'Registration を追加';
    byId('registration-id').value = registration?.id || '';
    byId('registration-version').value = registration?.version || '';
    byId('repository').value = registration?.repository || '';
    byId('repository').readOnly = Boolean(registration);
    byId('enabled').checked = registration?.enabled ?? true;
    byId('issue-enabled').checked = registration?.issueMonitorEnabled ?? true;
    byId('pr-enabled').checked = registration?.prMonitorEnabled ?? true;
    byId('execution-enabled').checked = registration?.executionEnabled ?? false;
    byId('registration-dialog').showModal();
    byId('repository').focus();
  }

  async function saveRegistration(event) {
    event.preventDefault();
    const id = byId('registration-id').value;
    const version = byId('registration-version').value;
    const repository = byId('repository').value.trim().toLowerCase();
    const body = {
      enabled: byId('enabled').checked,
      issueMonitorEnabled: byId('issue-enabled').checked,
      prMonitorEnabled: byId('pr-enabled').checked,
      executionEnabled: byId('execution-enabled').checked,
    };
    if (!id) body.repository = repository;
    const scope = id ? `update:${id}:${version}` : `create:${repository}`;
    const headers = { 'Idempotency-Key': commandKey(scope) };
    if (id) headers['If-Match'] = `"${version}"`;
    byId('save-registration').disabled = true;
    byId('registration-error').hidden = true;
    let versionConflict = false;
    try {
      const response = await api(id ? `/v1/registrations/${id}` : '/v1/registrations', {
        method: id ? 'PATCH' : 'POST', headers, body: JSON.stringify(body),
      });
      const page = await statusPage(`/v1/registrations?repository=${encodeURIComponent(repository)}`);
      const verified = page.items?.[0]?.registration;
      const expected = response.registration;
      if (!verified || verified.version !== expected.version
        || ['enabled', 'issueMonitorEnabled', 'prMonitorEnabled', 'executionEnabled']
          .some((key) => verified[key] !== expected[key])) {
        throw new Error('authoritative re-query did not verify the command outcome');
      }
      clearCommandKey(scope);
      await load({ announce: false });
      state.restoreSelector = id ? `[data-edit="${CSS.escape(id)}"]` : '#create';
      byId('registration-dialog').close();
      live(`${repository} version ${verified.version} の反映を確認しました (${response.outcome.outcome})`);
    } catch (error) {
      live(`保存失敗: ${error.message}`);
      handleOperationalFailure(error);
      showDialogError('registration-error', error);
      versionConflict = error.body?.outcome?.outcome === 'version_conflict';
      byId('registration-reload').hidden = !versionConflict;
    } finally {
      byId('save-registration').disabled = versionConflict || !state.connected;
    }
  }

  async function disableRegistration(event) {
    event.preventDefault();
    const r = state.selected;
    if (!r) return;
    const scope = `disable:${r.id}:${r.version}`;
    byId('confirm-error').hidden = true;
    try {
      const response = await api(`/v1/registrations/${r.id}/disable`, {
        method: 'POST',
        headers: { 'Idempotency-Key': commandKey(scope), 'If-Match': `"${r.version}"` },
        body: '{}',
      });
      const page = await statusPage(`/v1/registrations?repository=${encodeURIComponent(r.repository)}`);
      const verified = page.items?.[0]?.registration;
      if (!verified || verified.enabled || verified.version !== response.registration.version) {
        throw new Error('authoritative re-query did not verify disable');
      }
      clearCommandKey(scope);
      await load({ announce: false });
      state.restoreSelector = `[data-select="${CSS.escape(r.id)}"]`;
      byId('confirm-dialog').close();
      live(`${r.repository} version ${verified.version} の無効化を確認しました (${response.outcome.outcome})`);
    } catch (error) {
      live(`無効化失敗: ${error.message}`);
      handleOperationalFailure(error);
      showDialogError('confirm-error', error);
    }
  }

  async function openDelivery(item, deliveryId) {
    rememberDialogTrigger();
    try {
      byId('delivery-error').hidden = true;
      const delivery = await api(`/v1/deliveries/${encodeURIComponent(deliveryId)}`);
      state.delivery = { item, delivery };
      byId('delivery-detail').innerHTML = `
        <dt>Delivery</dt><dd>${escapeHTML(delivery.id)}</dd>
        <dt>State</dt><dd>${escapeHTML(delivery.status)}</dd>
        <dt>Attempts</dt><dd>${Number(delivery.routeAttempts || 0)}</dd>
        <dt>Registration</dt><dd>${escapeHTML(delivery.registrationId || '—')} / version ${escapeHTML(delivery.registrationVersion || '—')}</dd>
        <dt>Last error</dt><dd>${escapeHTML(delivery.lastError || delivery.ignoredReason || '—')}</dd>
        <dt>Updated</dt><dd>${formatTime(delivery.updatedAt)}</dd>`;
      const retryable = delivery.status === 'failed'
        && delivery.registrationId === item.registration.id
        && delivery.registrationVersion === item.registration.version
        && item.registration.enabled
        && item.registration.executionEnabled;
      byId('retry-delivery').disabled = !retryable;
      byId('delivery-dialog').showModal();
      (retryable ? byId('retry-delivery') : byId('delivery-dialog').querySelector('[data-delivery-close]')).focus();
    } catch (error) {
      handleOperationalFailure(error);
      live(`Delivery 取得失敗: ${error.message}`);
    }
  }

  async function retryDelivery(event) {
    event.preventDefault();
    const current = state.delivery;
    if (!current) return;
    const delivery = current.delivery;
    const scope = `retry:${delivery.id}:${delivery.routeAttempts}:${delivery.registrationVersion}`;
    byId('retry-delivery').disabled = true;
    try {
      const response = await api(`/v1/deliveries/${encodeURIComponent(delivery.id)}/retry`, {
        method: 'POST',
        headers: { 'Idempotency-Key': commandKey(scope) },
        body: JSON.stringify({
          observedAttempts: delivery.routeAttempts,
          expectedRegistrationId: delivery.registrationId,
          expectedRegistrationVersion: delivery.registrationVersion,
        }),
      });
      const verified = await api(`/v1/deliveries/${encodeURIComponent(delivery.id)}`);
      const acceptedAttempt = verified.retryAttempts?.find((attempt) =>
        attempt.attemptId === response.retry.attemptId);
      if (response.retry.deliveryId !== delivery.id
        || response.retry.state !== 'pending'
        || verified.id !== delivery.id
        || verified.registrationId !== delivery.registrationId
        || verified.registrationVersion !== delivery.registrationVersion
        || verified.routeAttempts < delivery.routeAttempts
        || !['pending', 'processing', 'processed', 'ignored', 'failed'].includes(verified.status)
        || acceptedAttempt?.status !== 'accepted'
        || acceptedAttempt.observedRouteAttempts !== delivery.routeAttempts) {
        throw new Error('authoritative re-query did not verify retry');
      }
      clearCommandKey(scope);
      await load({ announce: false });
      state.restoreSelector = `[data-select="${CSS.escape(current.item.registration.id)}"]`;
      byId('delivery-dialog').close();
      live(`Delivery ${delivery.id} の再試行受付と durable ${verified.status} state を確認しました (${response.outcome.outcome})`);
    } catch (error) {
      live(`再試行失敗: ${error.message}`);
      handleOperationalFailure(error);
      showDialogError('delivery-error', error);
      byId('retry-delivery').disabled = !state.connected;
    }
  }

  async function start() {
    let session;
    try {
      session = await api('/v1/browser-session');
    } catch (error) {
      const handled = handleOperationalFailure(error);
      if (error.status === 401 || !handled) {
        byId('alert').hidden = false;
        byId('alert').textContent = 'Operator session がありません。起動時に表示された一回限りの loopback bootstrap URL を開いてください。';
      }
      live(`セッション確認失敗: ${error.message}`);
      return;
    }
    state.csrf = session.csrfToken;
    await load().catch(() => {});
  }

  byId('refresh').addEventListener('click', () => load().catch(() => {}));
  byId('load-more').addEventListener('click', loadMore);
  byId('create').addEventListener('click', () => openRegistration());
  byId('search').addEventListener('input', render);
  byId('anomaly-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.anomalyFilter = button.dataset.filter;
    byId('anomaly-filters').querySelectorAll('[data-filter]').forEach((candidate) =>
      candidate.setAttribute('aria-pressed', String(candidate === button)));
    render();
    live(`${button.textContent.trim()} で絞り込みました`);
  });
  byId('registration-form').addEventListener('submit', saveRegistration);
  byId('confirm-form').addEventListener('submit', disableRegistration);
  byId('delivery-form').addEventListener('submit', retryDelivery);
  document.querySelectorAll('[data-close]').forEach((button) =>
    button.addEventListener('click', () => byId('registration-dialog').close()));
  document.querySelectorAll('[data-confirm-close]').forEach((button) =>
    button.addEventListener('click', () => byId('confirm-dialog').close()));
  document.querySelectorAll('[data-delivery-close]').forEach((button) =>
    button.addEventListener('click', () => byId('delivery-dialog').close()));
  ['registration-dialog', 'confirm-dialog', 'delivery-dialog'].forEach((id) =>
    byId(id).addEventListener('close', restoreDialogFocus));
  byId('registration-reload').addEventListener('click', async () => {
    const id = byId('registration-id').value;
    state.restoreSelector = id ? `[data-select="${CSS.escape(id)}"]` : '#create';
    await load({ announce: false }).catch(() => {});
    byId('registration-dialog').close();
  });
  byId('cards').addEventListener('click', (event) => {
    const select = event.target.closest('[data-select]');
    const edit = event.target.closest('[data-edit]');
    const disable = event.target.closest('[data-disable]');
    const delivery = event.target.closest('[data-delivery]');
    const id = select?.dataset.select || edit?.dataset.edit || disable?.dataset.disable
      || delivery?.closest('.card')?.dataset.id;
    const item = state.items.find((candidate) => candidate.registration.id === id);
    if (!item) return;
    if (select) {
      state.selectedCardId = item.registration.id;
      render();
      document.querySelector(`[data-select="${CSS.escape(item.registration.id)}"]`)?.focus();
      live(`${item.registration.repository} の状態詳細を選択しました。異常: ${isAnomaly(item) ? 'あり' : 'なし'}`);
    }
    if (edit) openRegistration(item.registration);
    if (disable) {
      rememberDialogTrigger();
      state.selected = item.registration;
      byId('confirm-error').hidden = true;
      byId('confirm-dialog').querySelector('.danger').disabled = false;
      byId('confirm-copy').textContent = `${item.registration.repository} version ${item.registration.version} を無効化します。`;
      byId('confirm-dialog').showModal();
      byId('confirm-title').focus();
    }
    if (delivery) openDelivery(item, delivery.dataset.delivery);
  });
  byId('signout').addEventListener('click', async () => {
    try { await api('/v1/browser-session', { method: 'DELETE' }); } finally {
      state.csrf = '';
      state.items = [];
      state.connected = false;
      state.nextPageToken = '';
      byId('create').disabled = true;
      byId('load-more').hidden = true;
      byId('alert').hidden = false;
      byId('alert').textContent = 'Operator session を終了しました。再開するには新しい一回限りの bootstrap が必要です。';
      render();
      live('Operator session を終了しました');
    }
  });
  start();
})();
