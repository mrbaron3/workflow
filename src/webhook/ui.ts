import { webhookControlClientScript } from './ui-client.js';
import { WEBHOOK_CONTROL_STYLES } from './ui-styles.js';

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
${WEBHOOK_CONTROL_STYLES}
  </style>
</head>
<body>
<main>
  <header><div><h1>Webhook Control</h1><p>複数repoのGitHubイベントを、耐久受信箱から安全に配送します。</p></div>
    <div><span class="badge" id="mode-badge">loopback only</span>
      <button id="auto-refresh" class="secondary" type="button" aria-pressed="true">自動更新</button></div></header>
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
        <div id="repositories" class="stack" tabindex="-1" role="region" aria-labelledby="repos-title" aria-busy="true"><p data-empty>読み込んでいます…</p></div></section>
      <section class="panel" aria-labelledby="deliveries-title"><h2 id="deliveries-title">Recent deliveries</h2>
        <div class="table-wrap" tabindex="0" role="region" aria-labelledby="deliveries-title"><table><thead><tr><th scope="col">Repository</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Updated</th><th scope="col"><span class="visually-hidden">操作</span></th></tr></thead>
        <tbody id="deliveries"><tr data-empty><td colspan="6">読み込んでいます…</td></tr></tbody></table></div></section>
    </div>
  </div>
</main>
<script>
${webhookControlClientScript(WEBHOOK_UI_REFRESH_INTERVAL_MS, WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT)}
</script>
</body>
</html>`;
}
