/** Static presentation asset for the loopback webhook control page. */
export const WEBHOOK_CONTROL_STYLES = String.raw`
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
.repo { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:10px; padding:13px;
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
.edit-form { grid-column:1/-1; padding-top:10px; border-top:1px solid var(--line); }
.edit-form[hidden] { display:none; }
.visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width:800px) { .grid { grid-template-columns:1fr; } header { align-items:start; flex-direction:column; }
  .checks { grid-template-columns:1fr; } .table-wrap { overflow:auto; } }

`;
