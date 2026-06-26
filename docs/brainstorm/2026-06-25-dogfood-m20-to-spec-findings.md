# ドッグフード: to-spec で M20 認可層の epic spec を著した摩擦ログ

- 日付: 2026-06-25
- ステータス: 摩擦ログ（メタ成果物・確証/反証 済み）。改善仮説の**適用は別タスク・承認制**。
- 演習: to-spec skill を最上流モジュール M20 オーサリング層の要件定義に適用し、軋みを確証/反証する。

## 背景（何をしたか）

- 入力契約（再聴取せず消費）: [draft/_spec/modules/authoring-layer.md](../../draft/_spec/modules/authoring-layer.md)
  の `AUTH-FR-001..013`・レッドライン・テスト可能条件。固定制約として ADR-0001/0003/0004/0005/0007。
- 2026-06-19 の MR（manual-requirements.md / MR-ID）廃止を反映（authoring-layer.md の下書きは未反映だが、本演習では
  生成せず／圏外処理）。根拠: [docs/brainstorm/2026-06-19-to-spec-format-templates.md](2026-06-19-to-spec-format-templates.md)。
- 産出（試作・scratchpad 揮発）: `spec.md`（サブ機能 AUTH-A〜D・受け入れ基準 11 件）＋ `acceptance.yaml`
  （severity ＋ 自動 method ＋ 目標挙動の expected）。`check-spec.ts` exit 0（被覆・重複なし・manual 不在）。
- 署名はしない（store／署名ゲート未実装 = DF7）。「lint 通過＝署名可能水準」で停止。

## 成果物の被覆（AUTH-FR-001..013 → AC、取りこぼしゼロ）

| FR | 主旨 | 着地 |
| --- | --- | --- |
| AUTH-FR-001 | spec.md 構造 | AC-AUTH-001 |
| AUTH-FR-002 | AC-ID 安定性（renumber 禁止） | AC-AUTH-004 |
| AUTH-FR-003 | 自動採点制約（manual 禁止） | AC-AUTH-006 |
| AUTH-FR-004 | manual 分離（MR） | **圏外**（2026-06-19 MR 廃止・チャット指摘へ・非契約） |
| AUTH-FR-005 | 協業／ファイル分離 | AC-AUTH-002 |
| AUTH-FR-006 | 署名ゲート／status 派生 | AC-AUTH-008（＋ AC-AUTH-003 ゲート通過） |
| AUTH-FR-007 | gitSha pin／永続先 | AC-AUTH-007 |
| AUTH-FR-008 | drift 二段検知 | AC-AUTH-009 / 010 / 011 |
| AUTH-FR-009 | 分割ヒント（サブ機能一覧） | AC-AUTH-001（well-formed 構造に内包） |
| AUTH-FR-010 | AC ⇔ acceptance 被覆 | AC-AUTH-003（正）＋ AC-AUTH-005（異） |
| AUTH-FR-011 | system 層参照（非埋め込み） | AC-AUTH-007（systemRefs 版固定）＋ 事前条件（前方参照） |
| AUTH-FR-012 | 完了条件 | AC-AUTH-001（各サブ機能に完了条件節） |
| AUTH-FR-013 | 採番・整合のコード強制 | AC-AUTH-003 / 004 / 005 / 006（ゲート） |

分離不変条件（機械検査済み）: acceptance.yaml に `manual` 無し／spec.md に frontmatter 無し／grading キー行
0 件（散文での語の言及は可）／契約スキーマ埋め込み無し（system 層を前方参照）／manual-requirements.md 未生成。

## 摩擦ログ（DF1〜DF8）

各エントリ: 軋み ／ 出所（to-spec のどのステップ・規約か）／ 確証・反証 ／ 改善仮説。

### DF1 module → epic carving の欠落 — 確証

- 軋み: to-spec の `<epic-dir>` は epic 粒度を所与とするが、入力は module 文書（authoring-layer.md）。
  「これは 1 epic か複数 epic か」を判定する carving ステップが to-spec / draft に無い。
- 出所: SKILL.md step 1（Intake）と step 2（Write into `<epic-dir>`）が、epic-dir 既定を前提にしている。
- 確証/反証: **確証**。本演習は GLOSSARY「Epic=1 spec.md=1 機能」と greenfield 1:1 で人間が即断したが、
  skill はそのガイダンスを与えない。将来 module が複数 epic に育つと carving 規約が無い。
- 改善仮説: SKILL.md step 1 直前に carving チェック1文（「入力が module 粒度なら、High サブ機能群が単一 epic に
  収まるか判定し、収まらなければ epic を分ける。判定は人間」）、または references/ に「1 module = 初回 1 epic、
  サブ機能が相互独立に出荷可能化したら分割」。

### DF2 slice 漏れ（サブ機能一覧の誤読リスク） — 確証（回避成功）

- 軋み: 自然な分解（gate / sign / drift）は水平な処理段で相互依存し、独立出荷の slice ではない。サブ機能一覧が
  唯一の slicing hint で、設計層の slicing を spec 層へ漏らしやすい。
- 出所: feature-spec.md「サブ機能一覧」の意味（分割境界ヒント）が SKILL.md / テンプレに明記されていない。
- 確証/反証: **確証（ただし本演習は回避成功）**。AUTH-A〜D は相互依存（署名はゲート通過前提・ドリフトは署名前提）で
  別 epic にできない。「サブ機能一覧は slice でなく分割境界ヒント」と明示し slice 分解を設計層（to-detail-design）へ
  委ねて漏れを回避したが、skill 自身に注意書きが無く著者が混同しやすい。
- 改善仮説: feature-spec.md「サブ機能一覧」見出しコメントに「これは設計層への**分割境界ヒント**であり slice
  （独立出荷単位）ではない。相互依存・水平な処理段でよい」を明記。

### DF3 自己参照の罠（メタ機能のレイヤリング） — 確証

- 軋み: 著述層自身の spec が「spec 形式そのもの（AC-ID 形式・GWT 規約）」を定義すると循環する。
- 出所: to-spec に、メタ機能（ツール自身・契約形式・採点機構）を著すときの layering 指針が無い。
- 確証/反証: **確証**。本演習はヘッダで「スキーマは system 層 data-model へ前方参照、本 spec はプロセス／ゲート
  挙動のみ」と層を切って解消した。M20 特有だが、to-spec がメタ機能に適用される度に再発する一般的罠。
- 改善仮説: references/ に短節「メタ機能のレイヤリング: 機能が『契約／形式そのもの』を扱う場合、形式定義は
  system 層 data-model へ寄せ、spec.md は観測可能なプロセス／ゲート挙動に限定」。特殊ケースゆえ SKILL.md 本体
  でなく references が適切。

### DF4 greenfield 前方参照 — 確証（規約を確立）

- 軋み: M20 は未整備の system 層スキーマ（契約スキーマ）を参照せざるを得ない。
- 出所: to-spec に、参照先 system 層が未整備のときの前方参照規約が無い（§10 open）。
- 確証/反証: **確証＋本演習で規約確立**。前方参照は3点セットで表現できると確認: (a) 事前条件に「未整備・seed 予定・
  seed 順序」を明記、(b) レッドラインに「埋め込まない」、(c) AC で systemRefs を版固定（目標挙動）。
- 改善仮説: SKILL.md step 1 か feature-spec.md コメントに「参照先 system 層が未整備（greenfield）なら、事前条件に
  『seed 予定・前方参照・順序』を明記し、埋め込みで代替しない」を1文。

### DF5 MR scrub 未適用（入力下書き側の陳腐化） — 確証

- 軋み: 2026-06-19 の MR 廃止が authoring-layer.md（FR-004 / §3.2 / manualRequirementsRef）に未反映。
- 出所: to-spec の欠陥ではなく**入力下書きの陳腐化**。to-spec 側は既に「自動採点不能はチャット指摘」で正しい。
- 確証/反証: **確証＋本演習で scrub 適用**。manual-requirements.md を生成せず、FR-004 を「圏外（MR 廃止）」処理し、
  自動採点不能要件を散文＋チャット指摘へ一本化。check-spec も manual 不在を確認。
- 改善仮説: authoring-layer.md の §3.2 / FR-004 / manualRequirementsRef を別タスクで scrub（承認制）。
  to-spec 側の変更は不要。

### DF6 contract altitude（プロセスは契約化しない） — 確証（実地解決）

- 軋み: 「人間が GWT を書き AI が grading を提案する」分担は誰が書いたかを自動採点できない（プロセス属性）。
- 出所: feature-spec.md の受け入れ基準が、プロセス属性を AC に昇格させない指針を欠く。
- 確証/反証: **確証＋実地解決**。分担を事前条件（散文）に置き、AC-AUTH-002 は「成果物の分離（behavior は spec.md・
  grading は acceptance.yaml）」という観測可能性質に限定した。さらに著述中に「spec.md に severity が出現しない」と
  書くと、分担を説明する散文が必然的に "severity" の語を使い**自己テンション**が生じることを発見し、expected を
  「構造化された grading キー行（`severity:` 等）の不在（語の言及は可）」へ精密化した。
- 改善仮説: feature-spec.md 受け入れ基準コメントに「分担・協業の質などプロセス属性は AC にしない。成果物の
  **観測可能な性質**へ翻訳できるものだけ AC 化」を1文。AC-002 型の自己テンション（spec が自身の禁止対象語を散文で
  使う）も注意例として references に。

### DF7 検証天井 — 確証

- 軋み: check-spec.ts は構造（被覆・重複・manual 不在）のみ検査し grader は走らない。署名／store／drift は loop 1
  未ブートストラップで未実装のため、AUTH-C / D の AC は実行検証できない。
- 出所: ハーネス未ブートストラップという事実（to-spec の欠陥ではない）。
- 確証/反証: **確証**。AUTH-A / B（well-formed・ゲート）は既存 lint / unit_test で実行検証可能だが、AUTH-C（署名→
  ApprovedSpecRef 永続）・AUTH-D（drift）の method（db_state_check / unit_test）は「目標挙動」に留まり今は走らない。
  検証天井は計画どおり「lint 通過＝署名可能水準」。
- 改善仮説: to-spec への改善ではない。acceptance.yaml に「目標挙動（impl 未／実装後に実行検証）」を明示する慣習は
  有効（本演習で実践）。任意で未実装依存の AC に印（例コメント `# pending: store`）を付ける運用を検討可。

### DF8 ゲートの射程 — 確証（設計どおり）

- 軋み: check-spec.ts は spec.md ＋ acceptance.yaml の2ファイルのみ読む。
  （[check-spec.ts:25-40](../../.claude/skills/to-spec/scripts/check-spec.ts#L25-L40)）
- 出所: MR 廃止後は第三ファイルが無く、2ファイル前提は**正しい**。
- 確証/反証: **確証（設計どおり）**。「自動採点不能要件が散文／チャットへ正しく着地したか」はコードで強制できないが、
  それは contract altitude（DF6）の帰結で設計どおり。ゲートの射程を広げて散文を検査するのは contract altitude 違反。
- 改善仮説: 改善不要（設計の確認）。現状維持が正しい。

## 改善仮説の優先度（合成）

- **to-spec への小追記で対処（actionable）**: DF1（carving チェック1文）／DF2（サブ機能一覧＝slice でないと注記）／
  DF3（メタ機能 layering を references へ）／DF4（greenfield 前方参照を1文）／DF6（プロセスは AC 化しないと注記＋
  自己テンション注意例）。いずれも SKILL.md / feature-spec.md コメント / references への薄い追記で、rubric の焼き込み
  ではない（ADR-0005 の skill を薄く保つ方針と整合）。
- **入力下書き側の scrub（別タスク・承認制）**: DF5（authoring-layer.md の MR 設計を削除）。to-spec の変更は不要。
- **確認であって欠陥ではない**: DF7（検証天井＝ハーネス未ブートストラップ）／DF8（ゲート射程＝設計どおり）。

## やらないこと（本演習の圏外）

- to-spec スキル本体（SKILL.md / check-spec.ts / テンプレ / ADR）の改訂 — 本ログは**提案まで**。適用は別タスク・承認制。
- 署名（contract-approved 遷移）・system 層スキーマの seed（to-db-design 領分）・slice 分解（設計層）。
- spec 試作の正式 `specs/` 昇格 — まず scratchpad で形を見てから判断（昇格は別判断）。

## 関連

- 試作 spec（scratchpad・揮発）: `dogfood-m20/spec.md`・`dogfood-m20/acceptance.yaml`（昇格時は `specs/authoring-layer/` 等へ）。
- 入力契約: [draft/_spec/modules/authoring-layer.md](../../draft/_spec/modules/authoring-layer.md)。
- MR 廃止の根拠: [2026-06-19-to-spec-format-templates.md](2026-06-19-to-spec-format-templates.md)。
