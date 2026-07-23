# Webhook コンテキスト — アーキテクチャ

- **ARCH-webhook-001 Ingress Port** — `receive(headers, body): DeliveryReceipt`。signature/loopback境界検証→schema parse→durable save→ACKの順を固定する（ADR-0010）。
- **ARCH-webhook-002 Repository Router** — Envelopeの`repository.full_name`とeventをRegistrationへ照合し、Normalized GitHub Eventを0..N consumerへ配送する。
- **ARCH-webhook-003 Reconciliation Scheduler** — Webhookとは独立した周期pollがGitHub current snapshotを取得し、同じNormalized Event/consumer seamへ不足workを供給する。repository registration単位で既存Open Issue/PRも探索し、item単位の事前登録を要求しない。
- **ARCH-webhook-004 Local Forwarder Manager** — enabled registrationごとに`gh webhook forward --repo --events --url`を監督し、設定変更時に対象processだけを再構成する。coreはprocess形を知らない。
- **ARCH-webhook-005 Consumer Adapters** — `agentops`はIssue intake/PR revision loopをwakeし、`orca-worktree-sync`は既存同期engineへ型付きeventを渡す。adapterだけが各runtimeを知る。
- **ARCH-webhook-006 Local Control UI** — loopback限定のHTTP UI/APIがRegistration、forwarder health、delivery履歴、failure replayを操作する。任意command入力は提供しない。
