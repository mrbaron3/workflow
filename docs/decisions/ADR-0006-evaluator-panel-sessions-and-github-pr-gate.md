# ADR-0006: evaluator パネルは観点ごとの独立 tmux セッションで fan-out し決定論コードが集約する。審査ゲートの UI は GitHub PR とする

- 状態: 採択（パネル部 E1-E7・ゲート部 G1-G3 とも `_system/execution` へ吸収済み＋決定論コア実装済み。残: 承認入力元の GitHub backend seam の裏）
- コンテキスト: execution（evaluation の採点語＝Scorecard/Verdict/grader を参照。再定義しない）
- 関連: [ADR-0005](ADR-0005-execution-layer-tmux-orchestration.md)（P4 観点パネル・Q3 審査ゲートの premise を実装可能な粒度へ具体化する）、
  [ADR-0003](ADR-0003-hard-gates-before-score.md)（hard-gate-before-score をパネル招集条件へ拡張）、
  [ADR-0001](ADR-0001-json-store-as-source-of-truth.md)（store＝SoT。GitHub PR は判断点の投影であって真実でない）

## 文脈

ADR-0005 は「evaluator＝観点パネル（P4・観点ごとの独立セッション）」「人間審査ゲート（Q3）」を premise として
確定したが、実装スライス（handoff task 11/12）に入るには一歩深い決定が要る:

1. **観点の実行単位** — 1 本の evaluator セッション内の**サブエージェント**（Claude Code の Task tool。
   サブエージェントにも専用コンテキストウィンドウ自体は与えられる）か、観点ごとの**独立 tmux セッション**か。
2. **実 backend のコスト構造** — 素朴に回すと 1 issue 最悪 generator 9 セッション＋ evaluator 63 セッション
   （3 samples × 3 attempts × 7 観点）。mock では無料でも実セッションでは時間・費用が成立しない。
3. **パネル → RepairBrief の集約** — 現 `buildRepairBrief`（`src/pipeline/repair.ts`）は単一 EvalRun 前提。
4. **審査ゲートの UI** — store 直（CLI/ダッシュボード）か、GitHub PR か。

設計対話（2026-07-05）で人間が確定: 観点セットは P4 の **7 観点のまま**（`LANG-execution-010`。
先行議論の architecture/performance という列挙は例示であって変更要求ではない）、**ゲート UI は GitHub PR**
（独自ダッシュボードは後から投影として追加可能）、コスト構造と集約は本 ADR の推奨を採用。

## 決定

### パネル実行モデル

- **E1 観点の実行単位＝独立 tmux セッション（サブエージェントでない）**。決め手は既存不変条件との整合:
  - fan-out / fan-in・集約をサブエージェント方式にすると**親セッションの LLM が制御を握る** →
    `DOM-execution-008` / `ARCH-execution-011`（決定論オーケストレータ）に違反する。
  - liveness（`ARCH-execution-014`/`015`）は pane 単位の観測。サブエージェントの stuck は外から見えず、
    「静かに終了しない」を保証できない。
  - sentinel（Q1）・EvalRun 記録・resume の粒度が観点単位になる: 完了済み観点が store に写り、
    途中で落ちても**未完の観点だけ**再走行できる。
  - 人間の attach・介入（審査点）が観点単位で可能になる。
  - なお**観点セッションの内部**でエージェントが探索のためにサブエージェントを使うのは seam の内側であり
    自由（制御フローは渡さない）。禁じるのは「パネルの編成・集約を LLM に委ねること」。
- **E2 functionality 観点＝決定論 grader backend（LLM セッション 0 本）**。functionality は hard gates
  （実 `tsc`/`vitest`）＋ AC 照合の grounded 採点で既に決定論的に出る（`src/graders/index.ts`）。LLM
  セッションを立てるのは判断を要する **6 観点**（codeQuality / testQuality / ux / accessibility / security /
  type-design）。原則: **観点＝Verdict を出す単位であり、その backend は pluggable**（AgentRunner seam と
  同じ思想。決定論で出せる観点にトークンを使わない）。
- **E3 evaluator セッションの契約＝read-only reviewer**。worktree を**編集しない**（Read 系 tool のみ許可）。
  出力は `.agentops/eval/<perspective>/findings.json`（zod 検証・`ARCH-execution-010`）＋同ディレクトリの
  sentinel。検証失敗は 1 回だけ re-drive し、なお失敗なら `needs-human-review` へ昇格する
  （`ARCH-execution-015`: 静かに捨てて approve 側へ倒さない）。`.agentops/` が changedFiles / scope_check から
  除外される既存の足場をそのまま使う。
- **E4 招集条件と並行度**。パネルは **hard gates 通過後にのみ**招集する（ADR-0003 の招集条件への拡張。
  gate 落ちの attempt は gate findings から直接 RepairBrief を作り、LLM トークンを一切使わない）。招集後は
  **6 観点を全て並行に fan-out** し、観点先行の short-circuit はしない: attempts（≤ 3）は トークンより希少で、
  同一 attempt で全観点の指摘を出し切る方が修正往復が少なく済む。並行は wall-time 約 1 セッション分。
  並行上限は config `panel.maxConcurrent`（マシン・rate limit 都合の飽和防止）。

### コスト既定（実 backend）

- **E5 実 backend の既定＝`samples: 1` ＋ first-approve-stop**。best-of-N（samples ≥ 2・全 sample 完走＝
  pass@k / pass^k の計測走行）は**計測したい issue にだけ opt-in**。mock backend は従来通り samples=3 全完走
  （無料・決定論・Eval DB の基質）。coordinator の「approve 後も全 sample 完走」は計測モードの挙動であって
  実 backend の既定にしない。

### 集約と修復

- **E6 集約＝決定論コード**。sample の最終 Verdict は `DOM-execution-004`（blocker 観点が 1 つでも
  request_changes なら request_changes。スコア平均で blocker を相殺しない）で**派生**させ、集約値は保存しない
  （`DATA-execution-001`）。
- **E7 RepairBrief のパネル対応**。観点別 EvalRun 群を横断して blocker-first で統合し、criterionId で重複を
  まとめ、各 instruction に**発生源観点**をタグ付けする。修復後の再採点で「どの観点の指摘が解消されたか」を
  帰属記録する — Analyst の「repair 成功率が低い」診断を観点別に分解できるようにする（改善ループの燃料）。

### 審査ゲート（Q3 の UI）

- **G1 ゲート UI＝GitHub PR**。パネル集約が approve → 決定論コードが branch を push し `gh pr create`
  （本文＝scorecard の人間可読 render、観点別 findings はコメント）。**人間の merge＝承認**。store とは
  `PR.externalRef`（additive）で対応付け、PR 状態は L1 と同型の**ポーリング**で検知する（webhook を建てない）:
  merged → `released`、changes-requested / closed → `needs-human-review`。
- **G2 store＝SoT は不変**。GitHub PR は**人間判断点の UI（投影）**であって真実ではない（ADR-0001）。
  独自ダッシュボードは後から別の投影として追加できる。
- **G3 ゲート＝ラベル収穫点**。人間のゲート判定を `EvalRun.humanVerdict` へ自動記録する: パネル approve を
  人間が merge＝true-pass、差戻し＝**false-pass 1 件**。恒常 null だった falsePassRate（`metrics.ts` /
  `analyst.ts` 参照）が**運用から**較正され、grader 改善（北極星「評価」軸）の calibration set が
  ラベリング作業なしに育つ。

## 帰結

- ＋ 決定論境界・liveness・sentinel・resume という既存不変条件を、そのまま観点粒度まで延長できる。
- ＋ トークン消費は「hard gates を通過した attempt × 6 観点」に限定され、修正往復は 1 attempt 1 回で済む。
- ＋ ゲートが GitHub PR になり、diff レビュー・コメント・履歴という既存 UX が判断点になる。ラベルが只で貯まる。
- − schema に additive 変更（`PR.externalRef`）。状態機械に `build-approved` が未実装
  （`DOM-execution-007` が参照するが `src/domain/states.ts` に無い）→ 遷移追加が要る。
- − 既存 reader（metrics / curator / dashboard）は「1 attempt＝1 EvalRun」前提 → `perspective ≠ null` の
  run を数え方から分離する改修が要る（詳細は handoff の詰まり所）。
- − GitHub PR ゲートは remote と `gh` 認証が前提 → ローカル使い捨て sandbox では fallback が要る。
- − `agents/evaluator-<perspective>.md` 6 本の著述が要る。
- 後続: `config.cli` の `claude -p` 既定の除去（ADR-0005 Q2 の残債）、ゲート部（G1-G3）の gate spec 化＋吸収。

## 実装先（吸収先 id・吸収規約 = decisions/README §吸収の強制）

パネル部（E1-E7）の premises が着地した system-layer / コードの id。views の各 id は本 ADR を逆参照する。

| premise | 吸収先（system view id） | 実装 |
| --- | --- | --- |
| E1 観点＝独立セッション／E2 functionality 決定論・6 観点 LLM／E3 read-only | `ARCH-execution-006`（注記追加） | `src/pipeline/panel.ts` `runPanel` / `PERSPECTIVES` |
| E4 gate-before-panel | `ARCH-execution-016`（新規不変条件） | `panel.ts` `runPanel` ＋ `graders` `hasBlockingGateFailure` |
| 集約（blocker 優先・派生・保存しない） | `DOM-execution-004` / `DATA-execution-001` | `panel.ts` `aggregatePanelVerdict` |
| E3 不正出力の昇格 | `ARCH-execution-015` | `panel.ts` `runPanel`（gradeWithRetry→needs-human-review） |
| E7 観点横断 repair | `ARCH-execution-006`（注記） | `src/pipeline/repair.ts` `buildPanelRepairBrief` |
| reader 非二重計上 | `DATA-execution-001` | `src/metrics/metrics.ts` `perSample`（attempt 集約） |
| G1-G3 審査ゲート（build-approved→承認→released・humanVerdict 収穫） | `ARCH-execution-008` / `DOM-execution-007` | `src/pipeline/execution/loop.ts` `applyPanelVerdict`／`recordHumanDecision`＋`states.ts` `build-approved`（承認入力元の GitHub backend は未実装・seam の裏） |
| L1 watch 常駐（poll→drive→gate） | `ARCH-execution-001` / `ARCH-execution-002` | `src/pipeline/execution/loop.ts` `driveOnce`／`watch` |

spec: `docs/specs/evaluator-panel/`（署名済み・9 AC）＋`docs/specs/execution-loop/`（署名済み・8 AC）。
issues: ISSUE-0003/0004/0005（パネル）・ISSUE-0006/0007（ゲート・watch）＝すべて contract-drafted。
テスト: `test/panel.test.ts`（12）＋`test/execution-loop.test.ts`（10）＝9＋8 AC を grounding。
