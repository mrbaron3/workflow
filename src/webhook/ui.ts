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
    button:focus-visible,input:focus-visible { outline:3px solid #91ffe0; outline-offset:2px; }
    .stack { display:grid; gap:10px; }
    .repo { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; padding:13px;
      background:#0c1428; border:1px solid var(--line); border-radius:11px; }
    .repo strong { font-size:15px; }
    .meta { color:var(--muted); font-size:12px; margin-top:4px; }
    .health { display:inline-block; margin-left:8px; font-size:11px; }
    .health-running { color:var(--accent); } .health-stopped { color:var(--warn); }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:12px; }
    .status-failed { color:var(--bad); } .status-ignored { color:var(--warn); }
    .status-processed { color:var(--accent); }
    #notice { min-height:24px; margin-top:12px; color:var(--accent); }
    @media (max-width:800px) { .grid { grid-template-columns:1fr; } header { align-items:start; flex-direction:column; }
      .checks { grid-template-columns:1fr; } .table-wrap { overflow:auto; } }
  </style>
</head>
<body>
<main>
  <header><div><h1>Webhook Control</h1><p>複数repoのGitHubイベントを、耐久受信箱から安全に配送します。</p></div>
    <span class="badge">loopback only</span></header>
  <div class="grid">
    <section class="panel" aria-labelledby="add-title">
      <h2 id="add-title">Repositoryを追加</h2>
      <form id="repo-form">
        <label for="repository">GitHub repository</label>
        <input id="repository" name="repository" type="text" required pattern="[^/ ]+/[^/ ]+"
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
        <div id="repositories" class="stack"></div></section>
      <section class="panel" aria-labelledby="deliveries-title"><h2 id="deliveries-title">Recent deliveries</h2>
        <div class="table-wrap"><table><thead><tr><th>Repository</th><th>Event</th><th>Status</th><th>Attempts</th><th>Updated</th><th></th></tr></thead>
        <tbody id="deliveries"></tbody></table></div></section>
    </div>
  </div>
</main>
<script>
const EVENT_VALUES = ['issues','pull_request','pull_request_review','pull_request_review_comment','check_run','check_suite','push','issue_comment'];
const CONSUMER_VALUES = ['agentops','orca-worktree-sync'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function checks(root, name, values, defaults) {
  root.innerHTML = values.map(value => '<label class="check"><input type="checkbox" name="'+name+'" value="'+value+'" '+(defaults.includes(value)?'checked':'')+'>'+value+'</label>').join('');
}
checks(document.querySelector('#events'),'events',EVENT_VALUES,['issues','pull_request','pull_request_review','pull_request_review_comment','check_run']);
checks(document.querySelector('#consumers'),'consumers',CONSUMER_VALUES,['agentops']);
async function api(path, options={}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
}
async function refresh() {
  const state = await api('/api/state');
  const forwarders = new Map((state.runtime?.forwarders || []).map(row => [row.registrationId,row.state]));
  document.querySelector('#repositories').innerHTML = state.repositories.length
    ? state.repositories.map(repo => { const health=forwarders.get(repo.id)||'stopped'; return '<article class="repo"><div><strong>'+esc(repo.repository)+'</strong><span class="health health-'+esc(health)+'">'+esc(health)+'</span><div class="meta">'+esc(repo.events.join(', '))+' · '+esc(repo.consumers.join(', '))+(repo.workspaceRoot?' · '+esc(repo.workspaceRoot):'')+'</div></div><button class="secondary toggle" data-id="'+esc(repo.id)+'" data-enabled="'+repo.enabled+'">'+(repo.enabled?'停止':'有効化')+'</button></article>'; }).join('')
    : '<p>まだrepositoryがありません。</p>';
  document.querySelector('#deliveries').innerHTML = state.deliveries.slice().reverse().slice(0,50).map(row =>
    '<tr><td>'+esc(row.repository)+'</td><td>'+esc(row.event+(row.action?' / '+row.action:''))+'</td><td class="status-'+esc(row.status)+'">'+esc(row.status)+(row.lastError?'<div class="meta">'+esc(row.lastError)+'</div>':'')+'</td><td>'+row.attempts+'</td><td>'+esc(new Date(row.updatedAt).toLocaleString())+'</td><td>'+(row.status==='failed'?'<button class="secondary retry" data-id="'+esc(row.id)+'">retry</button>':'')+'</td></tr>').join('');
}
document.querySelector('#repo-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const notice = document.querySelector('#notice');
  try {
    await api('/api/repositories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      repository:form.get('repository'), workspaceRoot:form.get('workspaceRoot')||null, enabled:true,
      events:form.getAll('events'), consumers:form.getAll('consumers'), readyLabel:null, baseBranch:null
    })});
    notice.textContent='追加しました。'; event.currentTarget.reset();
    checks(document.querySelector('#events'),'events',EVENT_VALUES,['issues','pull_request','pull_request_review','pull_request_review_comment','check_run']);
    checks(document.querySelector('#consumers'),'consumers',CONSUMER_VALUES,['agentops']); await refresh();
  } catch (error) { notice.textContent=error.message; }
});
document.addEventListener('click', async event => {
  const target = event.target;
  if (target.matches('.toggle')) { await api('/api/repositories/'+target.dataset.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:target.dataset.enabled!=='true'})}); await refresh(); }
  if (target.matches('.retry')) { await api('/api/deliveries/'+target.dataset.id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); await refresh(); }
});
refresh().catch(error => { document.querySelector('#notice').textContent=error.message; });
setInterval(() => refresh().catch(() => {}), 5000);
</script>
</body>
</html>`;
}
