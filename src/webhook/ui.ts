export const WEBHOOK_UI_REFRESH_INTERVAL_MS = 5_000;
export const WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT = 50;

export function webhookControlHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentOps Webhook Control</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2f; --line:#263352; --text:#eef2ff;
      --muted:#9ba8c7; --accent:#65d5b3; --warn:#ffca6a; --bad:#ff7b8b; }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
      background:radial-gradient(circle at 15% 0%,#16254a 0,transparent 35%),var(--bg); color:var(--text); }
    main { width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:36px 0 72px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:end; margin-bottom:24px; }
    h1 { margin:0; font-size:clamp(26px,4vw,42px); letter-spacing:-.035em; }
    h2 { margin:0 0 16px; font-size:18px; }
    p { color:var(--muted); margin:6px 0 0; }
    .badge { color:var(--accent); border:1px solid #2d695c; border-radius:999px; padding:6px 10px; }
    .grid { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(0,1.7fr); gap:18px; }
    .panel { background:color-mix(in srgb,var(--panel) 93%,transparent); border:1px solid var(--line);
      border-radius:16px; padding:20px; box-shadow:0 14px 40px #0004; }
    label,legend { font-weight:650; }
    input[type=text] { width:100%; margin:7px 0 14px; padding:11px 12px; border:1px solid var(--line);
      border-radius:9px; background:#0b1224; color:var(--text); }
    fieldset { border:0; padding:0; margin:0 0 14px; }
    .checks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; margin-top:8px; }
    .check { display:flex; gap:7px; align-items:center; color:var(--muted); font-weight:500; }
    button { border:0; border-radius:9px; padding:10px 13px; background:var(--accent); color:#062119;
      font-weight:750; cursor:pointer; }
    button.secondary { background:#263352; color:var(--text); }
    button:disabled { cursor:not-allowed; opacity:.55; }
    button:focus-visible,input:focus-visible,.table-wrap:focus-visible,tr:focus-visible { outline:3px solid #91ffe0; outline-offset:2px; }
    .stack { display:grid; gap:10px; }
    .repo { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; padding:13px;
      background:#0c1428; border:1px solid var(--line); border-radius:11px; }
    .repo strong { font-size:15px; }
    .meta { color:var(--muted); font-size:12px; margin-top:4px; }
    .health { display:inline-block; margin-left:8px; font-size:11px; }
    .health-running { color:var(--accent); } .health-stopped,.health-disabled { color:var(--warn); }
    .health-failed { color:var(--bad); }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:12px; }
    .status-failed { color:var(--bad); } .status-ignored { color:var(--warn); }
    .status-processed { color:var(--accent); }
    #notice { min-height:24px; margin-top:12px; color:var(--accent); }
    #notice.error { color:var(--bad); }
    #connection-status { min-height:24px; margin:0 0 18px; color:var(--muted); }
    #connection-status.error { color:var(--bad); }
    .operational-stale { border:2px dashed var(--warn); background:#181b2a; }
    .action-status { grid-column:1/-1; min-height:20px; color:var(--accent); font-size:12px; }
    .action-status.error { color:var(--bad); }
    .visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
      overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    @media (max-width:800px) { .grid { grid-template-columns:1fr; } header { align-items:start; flex-direction:column; }
      .checks { grid-template-columns:1fr; } .table-wrap { overflow:auto; } }
  </style>
</head>
<body>
<main>
  <header><div><h1>Webhook Control</h1><p>複数repoのGitHubイベントを、耐久受信箱から安全に配送します。</p></div>
    <div><span class="badge" id="mode-badge">loopback only</span>
      <button id="auto-refresh" class="secondary" type="button" aria-pressed="true">更新を一時停止</button></div></header>
  <div id="connection-status">
    <span id="connection-announcement" role="status" aria-live="polite">運用状態を読み込んでいます…</span>
    <span id="last-updated" aria-live="off"></span>
  </div>
  <div class="grid">
    <section class="panel" aria-labelledby="add-title">
      <h2 id="add-title">Repositoryを追加</h2>
      <form id="repo-form">
        <label for="repository">GitHub repository</label>
        <input id="repository" name="repository" type="text" required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
          placeholder="owner/repository" autocomplete="off">
        <label for="workspaceRoot">Workspace root（任意）</label>
        <input id="workspaceRoot" name="workspaceRoot" type="text" placeholder="/path/to/workflow">
        <fieldset><legend>Events</legend><div class="checks" id="events"></div></fieldset>
        <fieldset><legend>Consumers</legend><div class="checks" id="consumers"></div></fieldset>
        <button type="submit">追加する</button>
        <div id="notice" role="status" aria-live="polite"></div>
      </form>
    </section>
    <div class="stack">
      <section class="panel" aria-labelledby="repos-title"><h2 id="repos-title">Repositories</h2>
        <div id="repositories" class="stack" aria-busy="true"><p data-empty>読み込んでいます…</p></div></section>
      <section class="panel" aria-labelledby="deliveries-title"><h2 id="deliveries-title">Recent deliveries</h2>
        <div class="table-wrap" tabindex="0" role="region" aria-labelledby="deliveries-title"><table><thead><tr><th scope="col">Repository</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Updated</th><th scope="col"><span class="visually-hidden">操作</span></th></tr></thead>
        <tbody id="deliveries"><tr data-empty><td colspan="6">読み込んでいます…</td></tr></tbody></table></div></section>
    </div>
  </div>
</main>
<script>
const EVENT_VALUES = ['issues','pull_request','pull_request_review','pull_request_review_comment','check_run','check_suite','push','issue_comment'];
const CONSUMER_VALUES = ['agentops','orca-worktree-sync'];
const DEFAULT_EVENTS = ['issues','pull_request','pull_request_review','pull_request_review_comment','check_run'];
const DEFAULT_CONSUMERS = ['agentops'];
const actionStates = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const actionKey = (kind,id) => kind+':'+id;
function applyActionState(root, key) {
  const state=actionStates.get(key);
  if (!state) return;
  const button=root.querySelector('.toggle,.retry');
  const status=root.querySelector('.action-status');
  if (button) {
    button.disabled=state.pending;
    if (state.pending) button.setAttribute('aria-busy','true');
    else button.removeAttribute('aria-busy');
  }
  if (status) {
    status.textContent=state.message;
    status.classList.toggle('error',state.error);
  }
}
function setActionState(kind, id, state) {
  const key=actionKey(kind,id);
  actionStates.set(key,state);
  const root=document.querySelector('[data-key="'+CSS.escape(id)+'"]');
  if (root) applyActionState(root,key);
}
function pruneActionStates(kind, ids) {
  const visible=new Set(ids);
  for (const [key,state] of actionStates) {
    if (key.startsWith(kind+':') && !state.pending && !visible.has(key.slice(kind.length+1))) {
      actionStates.delete(key);
    }
  }
}
function checks(root, name, values, defaults) {
  root.innerHTML = values.map(value => '<label class="check"><input type="checkbox" name="'+name+'" value="'+value+'" '+(defaults.includes(value)?'checked':'')+'>'+value+'</label>').join('');
}
checks(document.querySelector('#events'),'events',EVENT_VALUES,DEFAULT_EVENTS);
checks(document.querySelector('#consumers'),'consumers',CONSUMER_VALUES,DEFAULT_CONSUMERS);
function notice(message, error=false) {
  const node=document.querySelector('#notice'); node.textContent=message; node.classList.toggle('error',error);
}
async function api(path, options={}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
}
async function refresh() {
  const state = await api('/api/state');
  setConnectionState('connected');
  document.querySelector('#mode-badge').textContent = 'loopback only';
  const forwarders = new Map((state.runtime?.forwarders || []).map(row => [row.registrationId,row]));
  reconcile(document.querySelector('#repositories'), state.repositories, repo => repo.id, repo => {
    const forwarder=forwarders.get(repo.id);
    const health=forwarder?.state||(repo.enabled?'stopped':'disabled');
    const healthDetail=forwarder?.error
      ? ' · '+forwarder.error+(forwarder.failedAt?' · '+new Date(forwarder.failedAt).toLocaleString():'')
      : '';
    const node=document.createElement('article'); node.className='repo';
    node.innerHTML='<div><strong>'+esc(repo.repository)+'</strong><span class="health health-'+esc(health)+'">'+esc(health+healthDetail)+'</span><div class="meta">'+esc(repo.events.join(', '))+' · '+esc(repo.consumers.join(', '))+(repo.workspaceRoot?' · '+esc(repo.workspaceRoot):'')+' · updated '+esc(new Date(repo.updatedAt).toLocaleString())+'</div></div><button class="secondary toggle" data-id="'+esc(repo.id)+'" data-subject="'+esc(repo.repository)+'" data-enabled="'+repo.enabled+'" aria-describedby="repo-action-'+esc(repo.id)+'" aria-label="'+esc(repo.repository+' を '+(repo.enabled?'停止':'有効化'))+'">'+(repo.enabled?'停止':'有効化')+'</button><div id="repo-action-'+esc(repo.id)+'" class="action-status" role="status" aria-live="polite"></div>';
    applyActionState(node,actionKey('repository',repo.id));
    return node;
  }, 'まだrepositoryがありません。');
  pruneActionStates('repository',state.repositories.map(row => row.id));
  const deliveries=state.deliveries.slice().reverse().slice(0,${WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT});
  reconcile(document.querySelector('#deliveries'), deliveries, row => row.id, row => {
    const node=document.createElement('tr'); node.tabIndex=-1; const detail=row.lastError||row.ignoredReason;
    node.innerHTML='<td>'+esc(row.repository)+'</td><td>'+esc(row.event+(row.action?' / '+row.action:''))+'</td><td class="status-'+esc(row.status)+'">'+esc(row.status)+(detail?'<div class="meta">'+esc(detail)+'</div>':'')+'</td><td>'+row.attempts+'</td><td>'+esc(new Date(row.updatedAt).toLocaleString())+'</td><td>'+(row.status==='failed'?'<button class="secondary retry" data-id="'+esc(row.id)+'" data-subject="'+esc(row.repository+' '+row.event)+'" aria-describedby="delivery-action-'+esc(row.id)+'" aria-label="'+esc(row.repository+' の '+row.event+' delivery を retry')+'">retry</button>':'')+'<div id="delivery-action-'+esc(row.id)+'" class="action-status" role="status" aria-live="polite"></div></td>';
    applyActionState(node,actionKey('delivery',row.id));
    return node;
  }, 'まだ配送がありません。', 6);
  pruneActionStates('delivery',deliveries.map(row => row.id));
}
function reconcile(root, rows, key, render, empty, colspan) {
  const existing=new Map([...root.children].filter(node => node.dataset.key).map(node => [node.dataset.key,node]));
  if (!rows.length) {
    if (!root.querySelector('[data-empty]')) {
      const focused=root.contains(document.activeElement);
      root.innerHTML=colspan?'<tr data-empty><td colspan="'+colspan+'">'+empty+'</td></tr>':'<p data-empty>'+empty+'</p>';
      if (focused) (root.closest('.table-wrap')||root).focus();
    }
    return;
  }
  root.querySelector('[data-empty]')?.remove();
  for (const row of rows) {
    const id=key(row); const old=existing.get(id); const fresh=render(row); fresh.dataset.key=id;
    const focused=old?.contains(document.activeElement);
    const focusSelector=focused && document.activeElement instanceof HTMLElement
      ? (document.activeElement.classList.contains('toggle')?'.toggle':document.activeElement.classList.contains('retry')?'.retry':null)
      : null;
    const previousStatus=old?.querySelector('.action-status');
    const freshStatus=fresh.querySelector('.action-status');
    if (previousStatus?.textContent && freshStatus) {
      freshStatus.textContent=previousStatus.textContent;
      freshStatus.classList.toggle('error',previousStatus.classList.contains('error'));
    }
    let current=fresh;
    if (!old) root.append(fresh);
    else if (old.innerHTML!==fresh.innerHTML) {
      old.replaceWith(fresh);
    } else current=old;
    root.append(current);
    if (focusSelector) (current.querySelector(focusSelector)||current).focus();
    existing.delete(id);
  }
  for (const stale of existing.values()) {
    if (stale.contains(document.activeElement)) {
      const surviving=[...root.querySelectorAll('[data-key] button, [data-key][tabindex]')]
        .find(candidate => !stale.contains(candidate));
      (surviving||root.closest('.table-wrap')||root).focus();
    }
    stale.remove();
  }
}
document.querySelector('#repo-form').addEventListener('submit', async event => {
  event.preventDefault(); const formElement=event.currentTarget;
  if (formElement.dataset.submitting==='true') return;
  const submit=formElement.querySelector('button[type="submit"]');
  formElement.dataset.submitting='true';
  submit.disabled=true; submit.setAttribute('aria-busy','true');
  notice('Repository を追加しています…');
  const form = new FormData(formElement);
  try {
    await api('/api/repositories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      repository:form.get('repository'), workspaceRoot:form.get('workspaceRoot')||null, enabled:true,
      events:form.getAll('events'), consumers:form.getAll('consumers'), readyLabel:null, baseBranch:null
    })});
    notice('追加しました。'); formElement.reset();
    checks(document.querySelector('#events'),'events',EVENT_VALUES,DEFAULT_EVENTS);
    checks(document.querySelector('#consumers'),'consumers',CONSUMER_VALUES,DEFAULT_CONSUMERS);
    try { await refresh(); }
    catch (error) {
      notice('追加しました。表示の更新に失敗しました。安全に再読み込みしてください。',true);
      reportDisconnect(error);
    }
  } catch (error) {
    notice(error.message,true);
  } finally {
    delete formElement.dataset.submitting;
    submit.disabled=false; submit.removeAttribute('aria-busy');
  }
});
document.addEventListener('click', async event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('.toggle,.retry')) {
    const retry=target.matches('.retry');
    const kind=retry?'delivery':'repository';
    const id=target.dataset.id;
    const key=actionKey(kind,id);
    if (actionStates.get(key)?.pending) return;
    const action=retry?'retry':'状態変更';
    const subject=target.dataset.subject||id;
    setActionState(kind,id,{
      pending:true,
      error:false,
      message:subject+' の '+action+' を実行中…',
    });
    let mutationSucceeded=false;
    try {
      if (!retry) await api('/api/repositories/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:target.dataset.enabled!=='true'})});
      else await api('/api/deliveries/'+id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      mutationSucceeded=true;
      setActionState(kind,id,{
        pending:false,
        error:false,
        message:subject+' の '+action+' が完了しました。',
      });
    } catch (error) {
      const message=subject+' の '+action+' に失敗しました: '+error.message;
      setActionState(kind,id,{pending:false,error:true,message});
      notice(message,true);
    }
    if (mutationSucceeded) {
      try { await refresh(); }
      catch (error) {
        const message=subject+' の '+action+' は完了しましたが、表示の更新に失敗しました。安全に再読み込みしてください。';
        setActionState(kind,id,{pending:false,error:true,message});
        notice(message,true); reportDisconnect(error);
      }
    }
  }
});
let refreshTimer;
let lastUpdatedAt;
let lastConnectionAnnouncement;
function setConnectionState(state, error) {
  const status=document.querySelector('#connection-status');
  const announcement=document.querySelector('#connection-announcement');
  const updated=document.querySelector('#last-updated');
  const operational=[document.querySelector('#repositories'),document.querySelector('.table-wrap')];
  let message;
  if (state==='connected') {
    lastUpdatedAt=new Date();
    message='接続済み · 表示は最新です';
    updated.textContent=' · 最終更新 '+lastUpdatedAt.toLocaleString();
  } else if (state==='paused') {
    message='更新を一時停止中';
    updated.textContent=' · 最終更新 '+(lastUpdatedAt?lastUpdatedAt.toLocaleString():'未取得');
  } else {
    message='daemon に接続できません。表示中の運用データは古い可能性があります: '+error.message;
    updated.textContent=lastUpdatedAt?' · 最終更新 '+lastUpdatedAt.toLocaleString():'';
  }
  if (message!==lastConnectionAnnouncement) {
    announcement.textContent=message;
    lastConnectionAnnouncement=message;
  }
  status.classList.toggle('error',state==='disconnected');
  for (const node of operational) { node.classList.toggle('operational-stale',state!=='connected'); node.setAttribute('aria-busy','false'); }
}
function reportDisconnect(error) { setConnectionState('disconnected',error); }
function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer=setInterval(() => refresh().catch(reportDisconnect), ${WEBHOOK_UI_REFRESH_INTERVAL_MS});
}
document.querySelector('#auto-refresh').addEventListener('click', event => {
  const active=event.currentTarget.getAttribute('aria-pressed')==='true';
  event.currentTarget.setAttribute('aria-pressed',String(!active));
  event.currentTarget.textContent=active?'更新を再開':'更新を一時停止';
  if (active) { clearInterval(refreshTimer); setConnectionState('paused'); }
  else { startRefresh(); refresh().catch(reportDisconnect); }
});
refresh().catch(reportDisconnect); startRefresh();
</script>
</body>
</html>`;
}
