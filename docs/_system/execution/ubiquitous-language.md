# ユビキタス言語 — execution コンテキスト

> execution コンテキストは、**issue queue を唯一の入力**として消費し、issue ごとに実装を役割セッションの
> オーケストレーションで自律に進める**独立層**を所有する（[ADR-0005](../../../decisions/ADR-0005-execution-layer-tmux-orchestration.md)）。
> Generator/Evaluator/Scorecard/Verdict といった「何を採点するか」の語は evaluation コンテキスト
> （`LANG-evaluation-NNN`）を**参照**し再定義しない——本コンテキストは「どう起動し・どう束ねるか」を足す。
> [context-map.md](../../context-map.md) の境界に従う。追加のみ（`LANG-execution-NNN` は安定）。

| ID | 用語 | 意味（execution コンテキスト内で一貫） |
| --- | --- | --- |
| LANG-execution-001 | 実装層 / Execution Layer | issue queue を唯一の入力として消費し、issue ごとに実装を自律で進める独立層。上流（planning/authoring/design）と queue で分離される（ACL）。上流の生成過程に依存しない。 |
| LANG-execution-002 | Issue Queue | store の `contract-drafted` **かつ** AI 指定（`LANG-execution-012`）された issue の集合。実装層の入力境界。 |
| LANG-execution-003 | Orchestrator | queue を poll し役割セッションを spawn・fan-in する**決定論コード**（LLM ではない）。evaluation の coordinator（`ARCH-evaluation-001`）を tmux 起動へ拡張したもの。 |
| LANG-execution-004 | Watch（常駐 poll） | orchestrator を poll ループで常駐させる運用。一発 `run`（queue を drain して exit）を包む。 |
| LANG-execution-005 | Session（役割セッション） | 1 ロールが 1 つの tmux **対話**セッションで、最小コンテキストだけを受けて処理を進める単位。揮発（真実は store）。`claude -p` headless ではなく attach 可。 |
| LANG-execution-006 | Scoped Context（最小コンテキスト） | セッションに渡す role 最適な最小情報。計画の木の `dependsOnSystem`（id 参照・never copied）から解決して組む。セッション間のコンテキスト汚染を防ぐ。 |
| LANG-execution-007 | Worktree（隔離チェックアウト） | sample ごとの git worktree。セッションが実ファイルを編集する隔離空間。sentinel と grade はここに対して行う。 |
| LANG-execution-008 | Sentinel（完了印） | セッション完了時に worktree へ書かれる印（`.agentops/done.json`）。orchestrator が polling で検知して grade へハンドオフする。tmux の生存は状態ではない。 |
| LANG-execution-009 | Evaluator Panel（観点パネル） | 単一 Evaluator（`LANG-evaluation-005`）でなく、**観点ごとに独立した Evaluator セッション群**。各自 Verdict（`LANG-evaluation-007`）を出し、集約する。 |
| LANG-execution-010 | Perspective（観点） | レビューの独立した lens。**7観点**＝functionality / codeQuality / testQuality / ux / accessibility（grader 5次元）＋ security ＋ type-design。 |
| LANG-execution-011 | Human Review Gate（人間審査ゲート） | legacy/store 手動経路と自動処理不能時の昇格先。GitHub PR-native 通常経路の merge 条件ではなく、通常判定は `LANG-execution-021` Revision Gate が担う。 |
| LANG-execution-012 | Scoping Guard / ai-managed | 実装層が触ってよい issue の **opt-in 指定**。`assignedAgent` が担当 AI に設定された issue のみ。未指定／他人が作った issue は決して触らない（デフォルト非処理）。 |
| LANG-execution-013 | Execution Backend | セッションを実行する基盤の pluggable な差し替え（自前 tmux／将来 Hermes）。evaluation の AgentRunner seam（`ARCH-evaluation-002`）の裏に位置する。 |
| LANG-execution-014 | Liveness / stuck | sentinel を出さないままセッションが進捗を止めた状態（入力待ち・質問・ハング）。正常完了（sentinel）に対する**異常停止**。auto-mode 起動でも起こり得るため、検知して顕在化する対象。 |
| LANG-execution-015 | Reviewer Workspace | build commit を読むために Perspective ごとに作る、破棄可能な detached checkout。評価対象の generator worktree とは別の物理 directory であり、reviewer が test を実行しても build commit や generator worktree は変わらない。 |
| LANG-execution-016 | Review Evidence Sidecar | Reviewer Workspace の外に置く Perspective 専用の prompt / findings directory。review evidence の書込みを評価対象 checkout の変更と混同せず、並行 Perspective 間でも共有しない。 |
| LANG-execution-017 | Environment Artifact Mutation | reviewer の依存確認・test 実行が disposable checkout に残した lockfile 等の、source/config 変更ではない明示分類済み副作用。観測・帰属してから checkout と共に破棄し、健全な findings を無効化しない。 |
| LANG-execution-018 | Verification Method Command | Acceptance Criterionの`verification.method`へtarget固有の実行commandを対応付ける設定。`typecheck`/`unit_tests`は互換aliasで、正規形はmethod-keyed registry。別methodへのfallbackをしない。 |
| LANG-execution-019 | Criterion Verification Evidence | 1つのACについて、宣言method・実command・pass/fail・境界を切った出力を保持するgrounded証拠。command未設定も`command:null`の失敗証拠として残る。 |
| LANG-execution-020 | PR Revision | 1つのGitHub PRの特定head SHA。レビュー・check・finding・承認が束縛される最小の配送単位。head更新で旧revisionの承認はstaleになる。 |
| LANG-execution-021 | Revision Gate | current PR Revisionについて、必須Perspective・hard gates・GitHub checks・blocking thread・mergeabilityを集約する決定論ゲート。 |
| LANG-execution-022 | Blocking Review Finding | P0/P1、blocker、`request_changes`、missing evidence等、current revisionのmerge資格を単独で拒否する指摘。 |
| LANG-execution-023 | Repository-discovered PR | Repository RegistrationからGitHub current snapshotをpollして取り込んだOpen PR。個別登録を持たず、外部PR番号で冪等化し、same-repository headだけを自動修正対象にする。 |
| LANG-execution-024 | External Work Identity | GitHub Source Issue由来の1 work unit / sampleを、canonical repository・external Issue番号・intake key・planning work-unit key・release correlation・sample indexで識別する安定identity。job-local Storeの表示ID（`ISSUE-0001`等）は含めない。branch・worktree・session・PR body markerの同じ派生元にする。 |
