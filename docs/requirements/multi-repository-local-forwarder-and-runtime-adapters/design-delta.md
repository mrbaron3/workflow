# Design delta

- Pythonのsingle-repo daemonを直接拡張せず、`src/webhook/*`のNode control planeへ置換する。
- `GithubWebhookForwarderSupervisor`はregistryを定期reconcileし、GUI以外の設定変更も拾う。
- runtime adapterは列挙名から固定実装を選び、workspace/repository整合性をfail-closedで検証する。
- optional Orca script pathはdaemon flag/environmentだけから受け取り、registrationには置かない。
