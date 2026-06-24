# 決定記録 0007: 設計層のエージェント分割と設計カデンツのグラデーション

- 状態: 確定
- 最終更新: 2026-06-24
- 影響モジュール: M21 Design Planner（文書種別で 3 専用エージェント: `to-basic-design` / `to-db-design` / `to-detail-design`・層別カデンツ・D49）/ M22 Design Reviewer（単一審査・派生図表は非ゲート・境界コンテキスト整合）/ M18 Storage（system層の住処 = 境界コンテキスト単位）/ M03 Coordinator（エージェント選択・first-touch 検知・並行時のロック単位 = 境界コンテキスト・loop2）/ 共有コード `src/design/lint.ts`（決定的 tier・各エージェントに vendor・進行管理も呼ぶ）/ ADR-0004（D31「adaptive」を「層別カデンツ」へ拡張・§6 open を解消）
- 正本差分: REQUIREMENTS.md への上書きなし（設計層の内部構造をさらに精密化するもの。ADR-0004 を拡張し override しない）

## 1. 背景

[ADR-0004](0004-layered-design-and-global-review.md) が設計を三層（system / epic / slice）に解凍し、
system 層を global 単一 SoT・追加のみに格上げした。だが ADR-0004 は **設計の「著者」を単一の Design Planner
（M21）**とし、**設計の「単位」を一律 epic** に置いていた。ここに二つの欠陥が残る。

- **(a) 著者が未分化**: 基本設計（アーキ）・DB 設計（データ）・詳細設計（slice）・図表は altitude も
  審査観点も専門性も違うのに、1 つの著者役へ畳まれていた。
- **(b) 設計単位が一律 epic で粗密が合わない**: data-model / domain-map は遅変・横断・slow-moving だが、
  epic ごとに「自分が要った分だけ」場当たり追加すると、別 epic が同一概念を別名・別テーブルで**二重設計**する。
  ファイルが global（ADR-0004 D31）でも、**trigger が per-epic なら piecemeal な accretion** になり、M22 の
  大域整合が事後に捕まえるだけになる。

本 ADR で設計層を **文書種別で 4 役に専門化**し、設計の単位を **層別のカデンツ（グラデーション）**に解凍する。
特に DB / domain を **境界コンテキスト単位**へ移し、二重設計を設計時に潰す。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D41 | 設計層を **文書種別で 4 著者役に専門化**: 基本設計（architecture + domain-map）/ DB 設計（data-model）/ 詳細設計（slice）/ 図表生成。現 M21 の**内部分割**であり、ADR-0004 の層/高度規律は不変 | 各文書は altitude・審査観点・専門性が違う。単一著者に畳むと専門性が出ず、ADR-0004 が解いた「未分化」を著者側に残す |
| D42 | **図表生成は派生レンダリング**: data-model / architecture / domain-map / slice を **source（SoT）から生成**し、図は SoT にしない・**非ゲート**・source 変更時に再生成する。図から導けない相互作用が要るなら、それは**設計に seam が欠けるサイン** | 図を独立著述すると 4 番目の drift 源になる。設計全体は「埋め込まず版固定参照で drift を機械検知（ADR-0001 D8）」で建つので、図はその派生でなければ整合しない |
| D43 | **詳細設計の高度 = seam / 契約まで**（ADR-0004 D34 を tier でなく「役」へ適用）。内部アルゴリズム・データ構造は**非ゲートの実装メモ**に留め Generator(M06) へ委ねる | 日本的「詳細設計」は内部実装まで書くが、薄い実装層（D34・ADR-0003）に反し、有能なモデルの品質を下げ陳腐化する。強制は契約 altitude のみ |
| D44 | **審査トポロジは M22 単一・層別 1 パス**。著者を 4 役に割っても**審査は割らない**。4 役の成果物をまとめて 1 人の独立審査役が層別セクションで審査する | 著者≠審査者の独立性（ADR-0002）は「審査を 1 つに保つ」で足りる。役ごとに審査を付けると多段ゲートで重く、loop1「最薄の縦 1 本」/ D33 に反する |
| D45 | **着工単位 = epic（per-feature）/ 整合単位 = global system 層**。big design up front は採らない。cross-epic 逐次整合は既存機構（additive + M22 大域整合 + drift 逆引き）で足り、**並行整合は loop2** で対処（loop1 では非実装） | 具体機能なしに引いた全体設計はほぼ外れる（ADR-0001 D1「抽象は具体の後」）。整合は設計順序でなく global SoT が担保する。作業と整合は別の軸 |
| D46 | **設計カデンツのグラデーション**: 層別に設計単位を変える。domain-map / data-model = **境界コンテキスト単位**（cross-epic 所有・遅変）/ architecture = モジュール境界 / slice（詳細設計）= **epic / PR** / 図表 = 派生。「全 epic 画一」は採らない | 層で変化速度・横断度・二重設計リスクが違う。一律 epic は (b) の場当たり追加を生む。ADR-0004 D31 の adaptive（触る層は subset）を「設計単位が層で異なる」へ拡張 |
| D47 | **DB / domain は lazy boundary / coherent within**: 触らない境界コンテキストは設計しない（D1 維持）が、**最初に触れた時点でその境界コンテキストのデータモデルを概念レベルで一貫設計**し、物理スキーマは必要分だけ additive。2 番目以降の同コンテキスト epic は **read のみ**（再設計しない） | 「lazy=speculative 回避」と「coherent=二重設計回避」を両立する唯一の畳み方。所有を epic でなく境界コンテキストのデータ設計責任へ移すことで、概念の別名重複を**設計時に**潰す |
| D48 | **並行整合のロック単位 = 境界コンテキスト**（`_system/` 全体ロックでない）。同コンテキストの epic は直列・別コンテキストは並行。loop2 で **まず直列化**し、スループット律速になったら**バッチ大域審査へ昇格**（D33 と同じ畳み方）。これにより ADR-0004 §6 open「domain-map を境界コンテキスト単位で割るか」を「**境界コンテキストを設計・所有・ロックの単位にする**」で解消 | 全体ロックは並行度を殺す。境界コンテキストを単位にすると、所有・カデンツ・ロックの粒度が一致し、並行性と整合を両立できる |
| D49 | 設計著者は **文書種別で 3 つの専用エージェントに分割**する: `to-basic-design`（domain-map + architecture・境界コンテキスト単位）/ `to-db-design`（data-model・境界コンテキスト単位）/ `to-detail-design`（slice・epic 単位）。各エージェントは **`context: fork` で隔離・`assets/` 出力テンプレ・frontmatter `hooks`（Stop）で決定的検査を強制**。図表は派生レンダラ（エージェントにしない）。決定的 tier は単一ソース `src/design/lint.ts` を各エージェントに **vendor（`npm run bundle-skills`）** し、進行管理側は src を呼ぶ（D37・重複実装しない）。D41 の「1 skill・2 モード」→ 2 skill を実装して実態確認した上で、本 3 エージェントに確定 | カデンツ分割（2 skill）は「1 SKILL を被った 2 skill」で本文を共有せず、文書種別ごとに専用テンプレ・専用 I/O・専用検査を持たせた方が責務と入出力が明確。公式の `context: fork` + skill 内 `hooks` で「専用エージェント＋検査強制」を規約準拠で実現できると確認。カデンツ（基本/DB=境界コンテキスト・詳細=epic）は外側が駆動し不変 |

## 3. 設計層の 4 役と成果物（D41-D44）

```text
要件定義（M20・人間署名 = Fix）
   │ ApprovedSpecRef（spec.md / acceptance.yaml @gitSha）
   ▼
設計層（M21 を文書種別で内部分割・著者は AI・層/高度規律は ADR-0004 のまま）
  ├─ 基本設計   → system: architecture.md(ARCH) / domain-map.md(DOM) ＋ epic: design-delta
  ├─ DB 設計    → system: data-model.md(DATA)
  ├─ 詳細設計   → slice: SLICE-*.md componentDesign（seam/契約まで・内部は実装メモ）
  └─ 図表生成   → 派生（下記 §5。SoT でない・非ゲート）
   │ IssueSpawnOrder（参照集合・版固定）
   ▼
M22 設計審査（単一・独立・層別 1 パス）── 4 役の成果物をまとめて審査
   │ DesignScorecard（system 拡張 = global / slice = epic 内）
   ▼
（pass）decomposed → M05 resolve → ...
```

- 4 役は M21 の専門化であり、新しい層を増やさない（成果物・要素 ID・版固定参照は ADR-0004 のまま）。
- 詳細設計は **DesignSlice.componentDesign を seam/契約まで**で書き、固定したいアルゴリズムのみ
  `implementationNotes`（非ゲート）に残す（D43 = ADR-0004 D34 の役適用）。
- M22 は 4 役の成果物を **1 人で・層別セクションで**審査する（D44）。派生図表（§5）は審査対象外・非ゲート
  （`implementationNotes` と同じ扱い）。

## 4. 設計カデンツのグラデーション（D46-D47）

設計の単位は層で異なる。一律 epic にしない。

| 層 | 変化速度 | 設計の単位（カデンツ） | 所有 | 二重設計リスク |
| --- | --- | --- | --- | --- |
| domain-map | 遅 | **境界コンテキスト** | cross-epic | 高 |
| data-model（DB） | 遅 | **境界コンテキスト**（epic より粗い） | cross-epic（データ設計責任） | **最高** |
| architecture | 中 | モジュール境界 | cross-epic | 中 |
| slice（詳細設計） | 速 | **epic / PR** | epic | 低 |
| 図表 | — | source 変更で再生成（派生） | — | — |

**lazy boundary / coherent within（D47）**:

1. **着工は lazy** — 触っていない境界コンテキストは設計しない（speculative 回避・ADR-0001 D1）。
2. **first touch で一貫設計** — 最初に触れた epic が、その境界コンテキストのデータモデルを**概念レベル
   （エンティティ・所有・関係・正規化）で一貫設計**する。物理スキーマは必要分だけ additive。
3. **以後は read** — 同一コンテキストの 2 番目以降の epic は read のみ。新概念・実拡張のときだけ additive。

> **順序制約**: 境界の引き方を誤ると二重設計が戻る（2 つに割った context が実は 1 つ）。境界は domain-map の
> 責務ゆえ、**domain 設計が data 設計に先行する**。グラデーションは順不同ではない。

## 5. 図表の派生（D42）

図は SoT でなく、下記 source からのレンダリング。変更時に再生成し、ゲートしない。

| 図 | source（SoT） |
| --- | --- |
| ER 図 | `data-model.md`（DATA） |
| コンポーネント図 | `architecture.md`（ARCH） |
| ドメイン図 | `domain-map.md`（DOM） |
| **シーケンス図** | slice `componentDesign` の seam 相互作用 ＋ `architecture.md` の seam |

> シーケンスの正本は「どのモジュールがどの seam を跨いで呼ぶか」= contract altitude の情報ゆえ、設計から
> **導出できる**。設計から導けない相互作用が図に要るなら、それは設計に seam が欠けるサイン（穴を炙り出す）。
> SoT を直さず図だけ足すのは禁止。

## 6. cross-epic 整合（D45・D48）

| ケース | 機構 | 状態 |
| --- | --- | --- |
| 逐次（B が commit 済みの A と整合） | additive system 層 + M22 大域整合 + system/AC drift 逆引き（ADR-0004 既存） | 既存で足りる |
| 並行（A・B が同時 `designing` で未 commit のデルタが衝突） | **境界コンテキスト単位の直列化**（同コンテキストは直列・別は並行。M03 のロック流用） | loop2・**まず直列化** |
| 直列化が律速 | **バッチ大域審査**（in-flight デルタ集合をまとめて審査 / 定期 reconciliation） | loop2・律速時に昇格 |

loop1 は単一機能ゆえ並行は発生せず、何も実装しない（早すぎる一般化を避ける・D1）。機構は記録に留める。

## 7. 既存 ADR / 正本との関係

- **ADR-0004 を拡張**（override しない）: D31 の「adaptive（触る層は subset）」を **D46 の層別カデンツ
  （設計単位が層で異なる）**へ拡張。**§6 open「system 層成果物の住処の粒度・domain-map を境界コンテキスト
  単位で分割するか」を D48 で解消**（境界コンテキストを設計・所有・ロックの単位にする）。
- **ADR-0002 と整合**: 著者を割っても審査の独立性は M22 単一で担保（D44）。
- **ADR-0003 / ADR-0004 D34 と整合**: 詳細設計の高度は seam/契約まで・内部は非ゲート実装メモ（D43）。
- **ADR-0006（loop1 最薄）と整合**: 本 ADR は設計層の**目標モデル**を定める。loop1 では ADR-0006 D3 のとおり
  最薄に運用する（4 役は薄く・単一著者でも可、M22 は決定的 tier 先行、カデンツ機構・並行制御は loop2 へ）。
- 正本差分なし: 設計層の内部構造の精密化であり REQUIREMENTS.md を上書きしない。

## 8. 残 open

- **loop1 でどこまで薄く起動するか**（詳細設計のみ薄く / 基本・DB は最小・ADR-0006 D3 連動）。設計著者の
  実装形態は D49 で確定済み（文書種別で 3 専用エージェント）。
- **Stop フックへの epic_dir 受け渡しの実機検証**: skill 引数 `$1` がフックコマンドに渡るかを対話セッションで
  確認する（未検証ゆえ現状はフック内で dir 不在なら fail-open）。権威的な検査ゲートは進行管理側が同じ lib を
  再実行する形で担保。
- **カデンツを駆動する M03 ディスパッチ**の起票（first-touch 検知・境界コンテキスト lock・モード選択）。
  これが無いとグラデーションは skill 単体では現れない。
- 図表の**レンダリング機構**（決定的スクリプト or AI）・保存場所・**source との drift 検知の有無**（再生成で
  足りるか、ズレを検知してゲートするか）。図表役 確定時。
- **first touch でどこまでモデル化するか**の判断境界（多すぎ = speculative/D1 違反、少なすぎ = piecemeal 復活）。
  操作的しきいは焼かず観測から起こす（D33 と同じ姿勢）。
- 境界コンテキストの**引き方**そのもの（domain-map がどう境界を定義し、data/arch がそれをどう単位として使うか）。
  M18 住処の具体（`_system/<context>/` 分割の有無）と連動。
- 並行直列化 → バッチ大域審査の**昇格契機**（loop2・M03/M22 確定時）。
