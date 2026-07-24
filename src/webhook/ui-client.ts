/** Browser behavior asset composed into the self-contained control page. */
export function webhookControlClientScript(
  refreshIntervalMs: number,
  visibleDeliveryLimit: number,
): string {
  return String.raw`
const EVENT_VALUES = ['issues','pull_request','pull_request_review','pull_request_review_comment','check_run','check_suite','push','issue_comment'];
const CONSUMER_VALUES = ['agentops','orca-worktree-sync'];
const DEFAULT_EVENTS = ['issues','pull_request','pull_request_review','pull_request_review_comment','check_run'];
const DEFAULT_CONSUMERS = ['agentops'];
const actionStates = new Map();
const editingRepositories = new Set();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const actionKey = (kind,id) => kind+':'+id;
function applyActionState(root, key) {
  const state=actionStates.get(key);
  if (!state) return;
  const buttons=root.querySelectorAll(key.startsWith('delivery:')
    ? '.retry'
    : '.toggle,.edit,.edit-save');
  const status=root.querySelector('.action-status');
  for (const button of buttons) {
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
function checkMarkup(name, values, selected) {
  return values.map(value => '<label class="check"><input type="checkbox" name="'+name+'" value="'+value+'" '+(selected.includes(value)?'checked':'')+'>'+value+'</label>').join('');
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
    node.innerHTML='<div><strong>'+esc(repo.repository)+'</strong><span class="health health-'+esc(health)+'">'+esc(health+healthDetail)+'</span><div class="meta">'+esc(repo.events.join(', '))+' · '+esc(repo.consumers.join(', '))+(repo.workspaceRoot?' · '+esc(repo.workspaceRoot):'')+' · updated '+esc(new Date(repo.updatedAt).toLocaleString())+'</div></div><button class="secondary edit" type="button" data-id="'+esc(repo.id)+'" aria-label="'+esc(repo.repository+' を編集')+'" aria-expanded="'+editingRepositories.has(repo.id)+'" aria-controls="repo-edit-'+esc(repo.id)+'">編集</button><button class="secondary toggle" data-id="'+esc(repo.id)+'" data-subject="'+esc(repo.repository)+'" data-enabled="'+repo.enabled+'" aria-describedby="repo-action-'+esc(repo.id)+'" aria-label="'+esc(repo.repository+' を '+(repo.enabled?'停止':'有効化'))+'">'+(repo.enabled?'停止':'有効化')+'</button><form id="repo-edit-'+esc(repo.id)+'" class="edit-form" data-id="'+esc(repo.id)+'" '+(editingRepositories.has(repo.id)?'':'hidden')+'><label>Workspace root（任意）<input name="workspaceRoot" type="text" value="'+esc(repo.workspaceRoot||'')+'" placeholder="/path/to/workflow"></label><label>Ready label（任意）<input name="readyLabel" type="text" value="'+esc(repo.readyLabel||'')+'"></label><label>Base branch（任意）<input name="baseBranch" type="text" value="'+esc(repo.baseBranch||'')+'"></label><fieldset><legend>Events（1つ以上）</legend><div class="checks">'+checkMarkup('events',EVENT_VALUES,repo.events)+'</div></fieldset><fieldset><legend>Consumers（1つ以上）</legend><div class="checks">'+checkMarkup('consumers',CONSUMER_VALUES,repo.consumers)+'</div></fieldset><button class="edit-save" type="submit">保存する</button></form><div id="repo-action-'+esc(repo.id)+'" class="action-status" role="status" aria-live="polite"></div>';
    applyActionState(node,actionKey('repository',repo.id));
    return node;
  }, 'まだrepositoryがありません。');
  pruneActionStates('repository',state.repositories.map(row => row.id));
  const deliveries=state.deliveries.slice().reverse().slice(0,${visibleDeliveryLimit});
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
      ? (document.activeElement.classList.contains('toggle')?'.toggle':document.activeElement.classList.contains('retry')?'.retry':document.activeElement.classList.contains('edit')?'.edit':document.activeElement.classList.contains('edit-save')?'.edit-save':null)
      : null;
    const previousStatus=old?.querySelector('.action-status');
    const freshStatus=fresh.querySelector('.action-status');
    if (previousStatus?.textContent && freshStatus) {
      freshStatus.textContent=previousStatus.textContent;
      freshStatus.classList.toggle('error',previousStatus.classList.contains('error'));
    }
    let current=fresh;
    if (!old) root.append(fresh);
    else if (old.querySelector('.edit-form:not([hidden])')) current=old;
    else if (old.innerHTML!==fresh.innerHTML) {
      old.replaceWith(fresh);
    } else current=old;
    root.append(current);
    if (focusSelector) {
      const matched=current.querySelector(focusSelector);
      const visible=matched?.closest('[hidden]')?current.querySelector('.edit'):matched;
      (visible||current).focus();
    }
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
  if (target.matches('.edit')) {
    const id=target.dataset.id;
    if (actionStates.get(actionKey('repository',id))?.pending) return;
    if (editingRepositories.has(id)) editingRepositories.delete(id);
    else editingRepositories.add(id);
    const form=target.closest('.repo').querySelector('.edit-form');
    form.hidden=!editingRepositories.has(id);
    target.setAttribute('aria-expanded',String(editingRepositories.has(id)));
    if (!form.hidden) form.querySelector('input').focus();
    return;
  }
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
document.addEventListener('submit', async event => {
  const formElement=event.target;
  if (!(formElement instanceof HTMLFormElement)||!formElement.matches('.edit-form')) return;
  event.preventDefault();
  const id=formElement.dataset.id;
  const key=actionKey('repository',id);
  if (actionStates.get(key)?.pending) return;
  const form=new FormData(formElement);
  const events=form.getAll('events');
  const consumers=form.getAll('consumers');
  if (!events.length||!consumers.length) {
    const message=!events.length?'Eventを1つ以上選択してください。':'Consumerを1つ以上選択してください。';
    setActionState('repository',id,{pending:false,error:true,message});
    return;
  }
  setActionState('repository',id,{pending:true,error:false,message:'設定を保存しています…'});
  try {
    const optional=name => {
      const value=String(form.get(name)||'').trim();
      return value||null;
    };
    await api('/api/repositories/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({
      events,consumers,
      workspaceRoot:optional('workspaceRoot'),
      readyLabel:optional('readyLabel'),
      baseBranch:optional('baseBranch'),
    })});
    const editButton=formElement.closest('.repo')?.querySelector('.edit');
    editingRepositories.delete(id);
    formElement.hidden=true;
    editButton?.setAttribute('aria-expanded','false');
    editButton?.focus();
    setActionState('repository',id,{pending:false,error:false,message:'設定を保存しました。'});
    try { await refresh(); }
    catch (error) {
      setActionState('repository',id,{pending:false,error:true,message:'設定は保存しましたが、表示の更新に失敗しました。'});
      reportDisconnect(error);
    }
  } catch (error) {
    setActionState('repository',id,{pending:false,error:true,message:'設定の保存に失敗しました: '+error.message});
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
  refreshTimer=setInterval(() => refresh().catch(reportDisconnect), ${refreshIntervalMs});
}
document.querySelector('#auto-refresh').addEventListener('click', event => {
  const active=event.currentTarget.getAttribute('aria-pressed')==='true';
  event.currentTarget.setAttribute('aria-pressed',String(!active));
  if (active) { clearInterval(refreshTimer); setConnectionState('paused'); }
  else { startRefresh(); refresh().catch(reportDisconnect); }
});
refresh().catch(reportDisconnect); startRefresh();

`;
}
