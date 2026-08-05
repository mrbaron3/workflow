# 複数 spec 並行実行（grounded skill 著述つき）受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「複数の pollable issue が 1 turn 内で同時に
> in-flight になり、資源衝突なく・依存を破らず・実測が計器に残って完走する」という観測可能な
> 性質。スケジューラの関数形・上限の設定キー名・計器の算出式は実装の裁量（ただし駆動 worker は
> 注入 seam で決定論テスト可能にする — 非機能要件）。
>
> **A4（skill 実走）の消化**: 本 spec の著述は to-spec skill、Issue 分解（issues.yaml）は
> to-detail-design skill の**実走**で行う — 「上流の著述自体が再現可能な部品になっていない」
> ギャップ（A4）をこの spec 自身の製造過程で閉じる（プロセス要件であり AC ではない —
> 実走ログが HANDOFF に残る）。
>
> **現状（A3 ギャップ）**: `runLoopLive` は queue を逐次 for-await する。tmux window 名と
> worktree パスは issue+sample 単位で一意（衝突しない下地は在る）が、同時 in-flight は
> 一度も起きていない。並行時の資源実測（D2）も計器に存在しない。
>
> **参照する固定制約**: `ARCH-execution-014`（liveness — 並行でもセッションは静かに死なない）／
> `ARCH-execution-015`（never-silent）／`DOM-execution-006`（opt-in ガード）／
> `DOM-execution-007`（審査は人間の判断点 — 並行化しても消えない）。dependsOn は
> acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Parallel spec execution with grounded skill authoring
- outcome（価値・なぜ今）: 2 spec の issue 群が同時 in-flight でも tmux/worktree/コストが衝突せず完走する。その spec 著述自体を to-spec / to-detail-design skill の実走で行い、skill 本体の grounded 未検証（④⑤の operator 直接著述代替）を同時に解消する。
- 計画の木リンク: feature=FEAT-008 epic=EPIC-03

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| PAR-A | 並行 dispatch（同時 in-flight・有限上限・衝突ゼロ・starvation なし） | 高 |
| PAR-B | 依存 DAG との整合（並行下でも FEAT-007 不変） | 高 |
| PAR-C | 並行 turn の資源計器（D2） | 中 |

## PAR-A 並行 dispatch

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・live turn）
- 何を: pollable な複数 issue を 1 turn 内で同時に in-flight にし、有限の上限内で全件を消化する
- なぜ: 逐次 drive では issue 数に壁時計が比例し、「1 issue 規模」の但し書きが消えない（M2 出口）。
  一方で上限なしの並行はコスト無限＝never-silent の反対側

**受け入れ基準**

- **[AC-PAR-001] 正常系: 複数 issue が同時 in-flight になり、有限上限の下で全件完走する**
  - Given pollable な issue が複数あり、同時実行上限（有限・設定可能・既定値あり）が 2 以上
  - When live turn を 1 回実行する
  - Then 少なくとも 2 issue の実行区間が重なり（同時 in-flight — 注入した駆動 worker の記録で
    観測可能）、上限を超える数が同時に走ることはなく、超過分は待機して順に実行され、
    最終的に queue の全 issue が drive される（starvation なし）。各 issue の作業空間と
    セッション識別子は issue ごとに一意で衝突しない。上限 1 の設定では従来の逐次と同一の
    順序・結果になる（後方互換）

## PAR-B 依存 DAG との整合

**ユーザーストーリー**

- 誰が: 進行管理役・人間（issue 分解の著者）
- 何を: 並行化しても依存チェーン（FEAT-007）の保証を破らない
- なぜ: 並行は依存違反の新しい入口になり得る（依存 pending の issue を「空きがあるから」と
  先行投入する誘惑）。DAG の尊重は並行度より優先する不変条件

**受け入れ基準**

- **[AC-PAR-002] 正常系: 未 released 依存を持つ issue は同時 in-flight 集合に決して入らない**
  - Given 依存チェーンを含む pollable/blocked 混在の queue と上限 2 以上
  - When live turn を実行する
  - Then 未 released 依存を持つ issue はその turn の同時 in-flight 集合に一度も入らず、
    ブロック報告（FEAT-007）は従来どおり現れる。依存の無い issue 同士だけが並行する

## PAR-C 並行 turn の資源計器

**ユーザーストーリー**

- 誰が: 人間（操舵判断）・進行管理役
- 何を: 並行 drive の資源実測（どれだけ同時に走ったか・上限は何か）を status で見る
- なぜ: 横幅（A2/A3）を安全に踏む前提は資源の可視化（D2）。測れない並行は
  コスト事故を「起きてから」しか知れない

**受け入れ基準**

- **[AC-PAR-003] 正常系: 並行 turn の実測が store に残り status に並ぶ**
  - Given 並行 live turn が完了した store
  - When status の機械可読出力を算出する
  - Then その turn の同時実行の実測最大値・駆動した issue 数・上限設定値が数値で並ぶ。
    並行 turn が一度も無い store では未観測として null（0 や 1 と混同しない — never-silent）

**非機能要件**

- 決定論: スケジューリングの全分岐（上限・待機・依存除外）は駆動 worker の注入 seam で
  実 tmux/実時間なしに検証できる。
- 可観測性: turn の並行実測は store の事実として残る（ADR-0001 — 「ログにだけある状態」を
  作らない）。
- 互換性: 既定の上限は有限。上限 1 で従来挙動と完全同一（additive）。

**完了条件**

- 自動テスト: 同時 in-flight＋上限＋starvation なし／依存除外／計器（実測・null）／上限 1 の
  後方互換 各 1 以上。
- 運用観測（released 後・grader 対象外）: 異なる 2 spec の issue（本 spec の後続 issue と
  FEAT-006 の issue）を同一 turn で drive し、**2 spec の issue 群の同時 in-flight 完走**
  （A3・M2 出口）と依存解除の turn 跨ぎ pickup（FEAT-007 実戦）を grounded で観測する。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 依存 DAG の尊重を並行度のために緩めない（FEAT-007 の保証は不変条件）。
- 人間ゲートを消さない・自動化しない（並行化は build までの並行であり、released は
  変わらず人間の判断点 — DOM-execution-007）。
- 上限なしの並行を導入しない（既定は有限。設定でも無限を許さない）。
- liveness / escalation の意味論を変えない（並行下でも stuck は kept-alive・escalate は
  握り潰さない — ARCH-execution-014/015）。
- 合格基準（既存テスト）を弱体化しない。
