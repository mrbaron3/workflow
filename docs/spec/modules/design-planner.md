# M21 Design Planner 仕様

- 正本参照: ADR-0001（[decisions/0001](../decisions/0001-authoring-execution-split.md) D10/D13/D14/D16/D17）,
  ADR-0002（[decisions/0002](../decisions/0002-independent-design-review.md) D20-D25・独立設計レビュ / 設計評価ループ）,
  REQUIREMENTS.md §11（Issue Contract 関連 FR）, §12（Generator 入力の前提）
- 参考実装: [agents/issue-planner.md](../../../agents/issue-planner.md)（**分割元**: 設計判断を本 M21 へ、
  resolve 機械処理を M05 へ振り分け）, `src/planning/planner.ts`（**置換**方針）
- 仕様状態: 下書き
- 最終更新: 2026-06-15

## 1. 目的とスコープ境界

`contract-approved` な spec.md（オーサリング SoT）を入力に、**詳細設計（二層: Tier1 アーキ・スパイン /
Tier2 設計スライス）** を著し、**PR サイズの issue へ分解（β）** する層。AI が著者で、人間 override は任意
（ADR-0001 D10/D13/D16）。epic ライフサイクルの `designing → (design-reviewed) → decomposed` を担う。
設計成果物は spawn 前に **M22 Design Reviewer の独立審査**を通る（ADR-0002 D20/D23）。本層は設計の**著者・
修正者**であり、審査者ではない（自己評価しない）。M22 の `DesignScorecard` で blocking が立てば本層へ差し戻され、
finding の逆引きキー（sliceId/ARCH-ID）で**該当箇所のみ**再設計する（ADR-0002 D24）。

設計（判断）と契約 resolve（機械処理）は性質が異なるため分離する（D13）。本層は**設計と分解の判断**を
担い、**resolve の実体**（spec.md@gitSha の AC + acceptance.yaml + Tier2 スライス → IssueContract への
機械投影）は M05 に委ねる。本層が固定するのは M05 への**引き渡し契約（何を渡すか）**まで。

担う:

- Tier1 アーキ・スパイン（epic 共有・決定のみ・repo に1ファイル）の著述
- Tier2 設計スライス（PR サイズ・1スライス = 1 issue）の著述
- AC をまたいだ PR サイズへの分解（β）。`subArea` を分割境界ヒントとして使用
- issue spawn 指示（specRef + AC-ID 群 + MR-ID 群 + Tier2 スライス参照）の生成 = M05 への handoff 契約
- 設計の human_review タグ点（Tier1 任意レビュー: D17）の決定
- spec drift 時の設計再判断（変更 AC-ID が触れる Tier1 決定 / Tier2 スライスの特定）

担わない（隣接モジュール）:

- spec.md / acceptance.yaml / manual-requirements.md の作成と署名 → M20 オーサリング層
- spec.md@gitSha → IssueContract の **resolve 実体**（投影の決定性・drift 再署名の機械処理）→ M05
- issue の投稿・状態機械・dispatch・ロック → M03 Coordinator
- 実装（コード詳細の確定はコード生成側）→ M06 Generator
- 実装成果（PR）の評価・scorecard → M07 Evaluator
- **設計成果物の審査・DesignScorecard**（被覆検証 + 整合性審査）→ M22 Design Reviewer（本層から独立: ADR-0002 D20）

> スコープ境界の要点（D13/D14）: 本層は **判断**（どう分割し、どう設計するか）を出力する。
> M05 は本層の出力を入力に **機械的に** IssueContract を組み立てる。境界は「Tier2 スライスを
> repo に置き、issue は参照を持つ」点（D8）。本層が埋め込み契約を作ることはない。

## 2. 入力契約 (consumes)

M20 が産出し、`contract-approved` で固定された参照群:

- **ApprovedSpecRef**（M20 §3.3）: `path` + `gitSha` + `approvedAcIds[]` + `approvedAt`。
  入力の不変条件は「gitSha 固定 = 設計入力の決定性」。
- **spec.md@gitSha**（M20 §3.1）: `acceptanceCriteria[]`（id / severity / behavior / subArea）, `scope`, `redLines`。
- **acceptance.yaml@gitSha**（M20 §3.1a）: AC-ID → `verification`(method + expected)。Tier2 の `testApproach` の根拠。
- **manual-requirements.md@gitSha**（M20 §3.2）: `MR-ID`（severity / requirement / tier）。
  `tier: human_review` の MR は分解時に対象 issue へ紐づけ、ゲートのトリガにする（D17）。

前提条件:

- epic 状態が `contract-approved`（署名済み）であること。未署名 spec には着手しない。
- 全 AC が acceptance.yaml に自動採点 method を持つ（M20 AUTH-FR-003 が保証）。

## 3. 出力契約 (produces)

設計成果物はいずれも **AI 著者・人間可読・repo 内・Git 追跡**（D14/D16）。issue には埋め込まず、
参照で渡す（D8）。epic ディレクトリの想定レイアウト:

```text
specs/<epic>/
  spec.md                       # M20: 人間著・AC behavior
  acceptance.yaml               # M20: AI+人間・verification
  manual-requirements.md        # M20: MR
  architecture-spine.md         # M21: Tier1（本層・epic に1ファイル）
  slices/SLICE-<EPIC>-NNN.md     # M21: Tier2（本層・PR サイズ・1:1 で issue）
```

### 3.1 Tier1 アーキ・スパイン（architecture-spine.md / epic 共有・決定のみ）

epic 全体で共有する **決定のみ**を持つ（D14）。コンポーネント詳細は持たない（それは Tier2）。

```text
ArchitectureSpine:
  epicId
  decisions[]:                  # 共有される設計決定のみ
    id:            ARCH-<EPIC>-NNN   （安定・不変。Tier2 から参照される）
    decision:      採用する構造 / 技術 / モジュール境界
    rationale:     なぜこの選択か
    affectsAcIds[]:  この決定が関わる AC-ID（drift 影響解析のキー）
    humanReview:   bool          # Tier1 任意レビュータグ（D17）
  moduleBoundaries[]:            # コンポーネント分割と責務の切れ目
  crossCuttingPolicies[]:        # 横断方針（エラー処理 / ログ / 契約規約 等）
  invariants[]:                  # epic 全体で破ってはならない不変条件
```

不変条件: `decision` は「決定」（採否のある判断）のみ。実装手順・コード断片を書かない（D14 の
「共有決定だけ epic に残す」を守る）。

### 3.2 Tier2 設計スライス（slices/SLICE-*.md / PR サイズ・1:1 で issue）

1スライス = 1 issue = 1 PR の単位（本セッションの設計選択。§10 参照）。複数 AC をまたいでよい（β: D10）。
Tier1 は**参照**し複製しない。

```text
DesignSlice:
  sliceId:         SLICE-<EPIC>-NNN   （安定・不変。issue / IssueContract の join キー）
  parentSliceId:   分割で生じた場合の親（renumber 禁止下の split 規約。後述）。なければ null
  title:           スライスの意味的な名前
  coversAcIds[]:   このスライスが満たす AC-ID 群（複数 AC をまたぐ: β）
  coversMrIds[]:   関連する manual requirement（human_review トリガ: D17）
  dependsOnSpine[]:  参照する ARCH-ID（Tier1 への参照。決定を複製しない）
  dependsOnSlices[]: 先行すべき他スライス（分解の依存順）
  componentDesign: PR サイズのコンポーネント詳細（人間可読・AI 著者: D16）
                   - 変更 / 新規ファイル・関数・データ構造の方針
                   - インターフェース・契約の局所的な形
  testApproach:    acceptance.yaml の verification を実装でどう満たすか（grader 視点の実装メモ）
  estimatedScope:  M21 の暫定 PR サイズ見積り（AI 判断）。実サイズは M05 resolve 後に確定（B5）
```

不変条件（**被覆かつ排他・双方向**: B1）:

- 全スライスの `coversAcIds` の和集合 == spec.md@gitSha の AC-ID 全集合（**双方向一致**。被覆漏れも
  孤児も禁止）。スライス間で AC-ID は重複しない。
- **AC は分割不可能な最小設計単位**（B1 の暗黙前提を明文化）。1 AC が PR サイズを超えるなら、それは
  複数の観測可能振る舞いを束ねた粗すぎる AC であり、**M20 へ差し戻して AC を分割**する（D17 WHAT→authoring）。
  M21 はスライス側で 1 AC を割らない（排他を保つ）。
- `sliceId` は renumber・再利用しない。**split 規約**: スライスが PR サイズを超える場合、AC の部分集合を
  別スライスに切り出す。`decomposed`（spawn）前なら新 sliceId を採番するだけ（自由）。spawn 後の再分割は
  drift 扱いで、親を retire し子に新 sliceId を振り `parentSliceId` で辿る。採番の high-water mark は
  `slices/` の既存最大番号スキャンで導出（M21 はステートレス。再分解時の番号衝突を防ぐ: Tier D 指摘）。

### 3.3 IssueSpawnOrder（M21 → M03/M05 への handoff 契約）

issue 投稿のための指示。**参照のみ**を持ち、契約本体は埋め込まない（D8）。M05 resolve の入力になる。

**全 Ref は版固定**（`{path, gitSha}`。B3）。spec.md だけ pin し設計ファイルを可変参照にすると、issue 投稿後に
設計ファイルが変わり spec と設計の版が食い違う。D8 の「参照 + 版固定」原則を設計ファイルにも及ぼす。

```text
IssueSpawnOrder:
  epicId
  sliceId:                SLICE-<EPIC>-NNN     # 1 spawn order = 1 slice = 1 issue
  specRef:                { path, gitSha }      # ApprovedSpecRef 由来（spec.md の版固定）
  acceptanceCriteriaIds[]:  このスライスが担う AC-ID（= DesignSlice.coversAcIds）
  manualRequirementIds[]:   human_review ゲートのトリガ（= DesignSlice.coversMrIds）
  tier2SliceRef:          { path, gitSha }      # Tier2 スライスの版固定参照（埋め込まない）
  tier1SpineRef:          { path, gitSha }      # Tier1 スパインの版固定参照
  dependsOn[]:            先行 issue（DesignSlice.dependsOnSlices から導出）
```

> M05 resolve はこの order を入力に `resolve(spec.md@gitSha の AC + acceptance.yaml + Tier2 スライス@gitSha)
> → IssueContract` を機械的に行う。本層は **order の形（参照集合）まで**を確定し、投影の中身は M05 の所掌。
> 運用簡略化として spec.md と設計ファイルを同一 commit に含めれば 3 つの gitSha は一致するが、強制はしない。

## 4. 振る舞い / 処理フロー

epic 状態 `contract-approved → designing → decomposed`（ADR-0001 §5）。**状態ラベルの書き込みは M03
Coordinator（通常コード）が行う**。M21 は LLM 著者ゆえ状態を直接書かず、成果物の完成を**シグナル**する
だけ（B2。「状態遷移を LLM にやらせない」原則）。下記は M21 の作業ステップで、各完了が M03 の遷移条件になる。

1. **着手**: M03 が `contract-approved` を確認し `designing` を書く。M21 は ApprovedSpecRef の gitSha で
   spec.md / acceptance.yaml / manual-requirements.md を pin して読む（入力決定性）。
2. **Tier1 スパイン著述**: epic 共有の設計決定（構造・技術・境界・横断方針・不変条件）を
   architecture-spine.md に書く。各決定に `affectsAcIds` と必要なら `humanReview: true` を付す。
3. **分解（β・設計主導）**: AC を PR サイズの **Tier2 スライス**へ束ねる。`subArea` を分割境界の
   **ヒント**として使う（1:1 では縛らない: D10）。被覆かつ排他（双方向）・PR サイズ・依存順を満たす。
4. **Tier2 スライス著述**: 各スライスに componentDesign / testApproach / dependsOnSpine を書く。
   Tier1 決定は参照（ARCH-ID）で引き、複製しない。
5. **human_review タグ判定**（D17）: `humanReview: true` の Tier1 決定、または `coversMrIds` に
   `tier: human_review` を含むスライスがあれば、当該 spawn order に review トリガを立てる。
6. **IssueSpawnOrder 出力**: スライスごとに spawn order（参照集合）を出力＝**設計完成をシグナル**。
7. **M22 独立審査**（ADR-0002 D23・本層の外）: M03 が M22 を dispatch。M22 が設計成果物を spawn 前に審査し
   `DesignScorecard` を産出。`pass`（blocking 空）なら M03 が `design-reviewed → decomposed` を書き issue を投稿、
   resolve は M05 が引き取る（本層の境界外）。`changes-requested` なら `designing` へ差し戻し、本層が再設計（下記）。

人間 override（任意・D10/D16）:

- `designing` の間、人間はスライス境界 / Tier1 決定を編集できる。routine ループには入らないが、
  読んで修正することは妨げない（「読まない ≠ 読めない」: D16）。

異常系・drift 連動:

- **AC drift（M20 起因・D17「WHAT→authoring」の戻り）**: spec.md / acceptance.yaml の drift で AC-ID が
  変更されると、M20 が当該 AC を `approvedAcIds` から外す。本層は変更/追加/削除 AC-ID を `affectsAcIds`
  （Tier1）と `coversAcIds`（Tier2）で逆引きし、**影響する Tier1 決定 / Tier2 スライスのみ**を再設計。
  **新規 AC は被覆漏れ**として新/既存スライスへ割付を強制、**削除 AC は孤児 coversAcIds** を検出し当該
  スライスを再設計（双方向被覆。B1）。無関係なスライスは触らない。
- **設計 drift（B3・新規）**: spec は不変だが Tier1 決定が override された場合、変更 `ARCH-ID` を
  `dependsOnSpine` に持つ Tier2 スライスを逆引きして再検証対象に挙げる（AC 逆引きと対称）。Tier1 を参照のみ
  にした（FR-008）ことで複製ズレは防げるが、参照先の決定変更への追従はこのフックが担う。
- **サイズ誤判定（B5・M05→M21 の戻り）**: M21 の `estimatedScope` は暫定見積り。M05 resolve 後に実サイズが
  PR を超えると判明した場合、当該スライスを `designing` 相当へ戻し split 規約（§3.2）で再分割する。
- **設計審査差し戻し（ADR-0002 D24・新規）**: M22 の `DesignScorecard` が `changes-requested`（blocking 非空）の
  とき、各 finding の逆引きキー（`refs[]`: ARCH-ID/sliceId/AC-ID）を AC drift と同じ機構で逆引きし、**該当する
  Tier1 決定 / Tier2 スライスのみ**を再設計する（全体再設計を強制しない）。再設計後に再シグナル → M22 再審査
  （設計内側ループ）。整合性違反（cross-slice 不一致・参照背反・AC 意図取りこぼし等）の修正が主。
- **アーキ差し戻し（D17）**: human_review から「アーキ差し戻し」を受けると、当該 Tier1 決定 / スライスを
  再設計対象に戻す。

## 5. 機能要件 (FR)

新規採番 `DSGN-FR-xxx`。

- **DSGN-FR-001 着手前提**: `contract-approved`（署名済み）の epic にのみ着手し、ApprovedSpecRef の
  gitSha で入力を pin する。未署名 spec には着手しない。
- **DSGN-FR-002 二層出力**: Tier1 アーキ・スパイン（epic に1ファイル・決定のみ）と Tier2 設計スライス
  （PR サイズ・1スライス=1 issue）を分けて産出する（D14 + 本セッション選択・§10）。
- **DSGN-FR-003 Tier1 = 決定のみ**: architecture-spine.md には共有設計決定のみを書き、コンポーネント
  詳細・実装手順を書かない。
- **DSGN-FR-004 被覆かつ排他（双方向）**: 全 Tier2 スライスの `coversAcIds` の和集合と spec.md@gitSha の
  AC-ID 全集合が**双方向一致**（被覆漏れも孤児も禁止）。スライス間で AC-ID は重複しない。AC は分割不可能な
  最小単位とし、PR サイズ超過 AC は M20 へ差し戻す（B1）。
- **DSGN-FR-005 PR サイズ分解（β）**: issue = PR サイズ。複数 AC をまたいで導出し、`subArea` は分割境界の
  ヒントとして使う（1:1 に縛らない: D10）。各スライスに `estimatedScope`（**M21 の暫定見積り**。実サイズは
  M05 resolve 後に確定: B5）を付す。
- **DSGN-FR-006 ID 安定性 / split 規約**: `ARCH-ID` / `sliceId` は一度振ったら不変。renumber・再利用を禁止。
  超過時の split は新 sliceId を採番（spawn 前は自由、spawn 後は親 retire + `parentSliceId`）。high-water mark
  は `slices/` の既存最大番号スキャンで導出（M21 ステートレス）。`sliceId` は issue / IssueContract の join キー。
- **DSGN-FR-007 参照渡し（全 Ref 版固定）**: IssueSpawnOrder は specRef + AC-ID 群 + MR-ID 群 +
  Tier2/Tier1 への `{path, gitSha}` **参照**のみを持ち、契約本体・設計本文を埋め込まない（D8 を設計ファイルへ拡張・B3）。
- **DSGN-FR-008 Tier1 参照（非複製）**: Tier2 スライスは Tier1 決定を `dependsOnSpine`(ARCH-ID) で
  参照し、決定内容を複製しない。
- **DSGN-FR-009 human_review タグ**: `humanReview` な Tier1 決定 / `tier: human_review` の MR を含む
  スライスに対し、当該 spawn order へ review トリガを立てる（D17）。
- **DSGN-FR-010 AC drift 影響局所化（双方向）**: 変更/追加/削除 AC-ID を `affectsAcIds` / `coversAcIds` で
  逆引きし、影響する Tier1 決定 / Tier2 スライスのみを再設計。新規 AC=被覆漏れとして割付強制、削除 AC=孤児
  スライス検出（B1）。無関係なスライスは不変。
- **DSGN-FR-011 設計 drift 局所化**: 変更された `ARCH-ID` を `dependsOnSpine` に持つ Tier2 スライスを逆引き
  して再検証対象に挙げる（AC 逆引きと対称・B3）。
- **DSGN-FR-012 状態シグナル（書き込みは M03）**: 本層は設計成果物の完成（spawn order 出力）を**シグナル**
  するのみ。`designing`/`decomposed` ラベルの書き込み・resolve・投稿は行わない（状態は M03、resolve は M05・B2）。

## 6. 非機能要件

- **入力決定性**: 同一 gitSha では同一の設計入力を読む。出力（設計判断）は AI 著述ゆえ完全決定的では
  ないが、入力 pin により再現・監査の基盤を確保する。
- **人間可読性**: Tier1/Tier2 は Markdown で人間可読を維持（D16）。grader 向け詳細ではなく設計判断を書く。
- **Git 追跡**: 設計成果物は repo 内に置き Git 履歴に乗せる（drift 解析・監査・保守の基盤）。
- **モデル独立性**: 著者 AI の provider/model に依存しない出力スキーマ（M16 準拠）。
- **可観測性 / 評価・改善トレース（C1）**: AC → スライス → issue の対応（双方向被覆）が機械的に検証可能。
  加えて、設計起因の実装失敗を北極星の三能力（評価・改善）に接続する**観測点を持つ**: 各 issue の評価結果
  （scorecard）と `sliceId` / `ARCH-ID` を紐づけ、「どの設計判断が後段の失敗に関与したか」を辿れるようにする。
  設計起因失敗（誤った分割・アーキ決定）を M10 Eval Curator / M12 Harness Analyst へ送る経路の**存在**を
  保証する（実体は当該モジュール確定時。ここでは接続点だけ規定）。**この層3 接続点の供給は M22 Design Reviewer に
  移譲**し、M22 が `design_failure` サブ分類で携帯する（ADR-0002 D25・[design-reviewer.md](design-reviewer.md) §6）。
  本層は逆引きキー（sliceId/ARCH-ID）を成果物に持たせることでその join を可能にする。

## 7. 不変条件・禁止事項 (red lines)

- spec.md / acceptance.yaml を**書き換えない**。SoT は M20（人間署名）。設計が WHAT を変えたくなったら
  層別差し戻し（WHAT→authoring: D17）で戻す。
- IssueSpawnOrder / issue に**契約本体・設計本文を埋め込まない**（参照のみ: D8）。
- AC をスライスから**取りこぼさない / 二重計上しない**（被覆かつ排他・双方向: DSGN-FR-004）。
- 1 AC をスライス側で分割しない（PR サイズ超過 AC は M20 へ差し戻す: B1）。
- `ARCH-ID` / `sliceId` を renumber・再利用しない。
- **状態ラベルを書き込まない**（書き込みは M03。本層は完成をシグナルするのみ: B2）。
- IssueSpawnOrder の参照は全て版固定（`{path, gitSha}`）。設計ファイルを可変参照で渡さない（B3）。
- Tier1 にコンポーネント詳細・実装手順を書かない（Tier2 の領分: D14）。
- 未署名（`contract-approved` 未満）の spec に着手しない。

## 8. 受け入れ条件 (testable)

- サンプル `contract-approved` spec.md（例: octolink 相当）から architecture-spine.md と
  複数の SLICE-*.md を生成でき、全 AC が**過不足なく**いずれかのスライスに割り付く（被覆かつ排他を検証）。
- 各スライスから IssueSpawnOrder（specRef + AC-ID 群 + MR-ID 群 + Tier2/Tier1 参照）を生成でき、
  契約本体・設計本文が**埋め込まれていない**ことを検証できる。
- `tier: human_review` の MR を含むスライスの spawn order に review トリガが立つ。
- spec.md の AC を1つ変更（drift）→ 影響する Tier1 決定 / Tier2 スライスのみが再設計対象に挙がり、
  無関係なスライスが不変であることを検証できる。
- AC を1つ**追加/削除**（drift）→ 追加 AC は被覆漏れとして割付要求、削除 AC は孤児スライスとして検出される
  （双方向被覆。B1）。
- Tier1 決定を1つ変更 → `dependsOnSpine` 逆引きで影響 Tier2 スライスのみが再検証対象になる（設計 drift。B3）。
- 本層は spawn order を出力するのみで、`designing`/`decomposed` ラベルの書き込み・resolve・投稿を行わない（B2）。

## 9. 既存実装とのギャップ / 移行方針

- [agents/issue-planner.md](../../../agents/issue-planner.md): 「設計 + 分解 + 契約生成」を一体で持つ
  → **分割**。設計判断（Tier1/Tier2）と分解を本 M21 へ、resolve（機械投影）を M05 へ。
- **正本 §11 DEV-PLAN-FR の再配分**（D13 の具体化）: 設計・分解判断 = 本 M21 / spec→IssueContract の
  resolve・schema validation = M05。旧 §11「Planner が契約を作成」は、判断（M21）と機械処理（M05）に二分された。
- `src/planning/planner.ts`: seed YAML から contract を直接生成する経路を **置換**。
  spec.md → Tier1/Tier2 設計 → IssueSpawnOrder（参照）→ M05 resolve に組み替える。
- `Issue.contract` 埋め込み（[schema.ts](../../../src/domain/schema.ts) L108）廃止と連動
  → spawn order は参照のみ（M05 / M18 と整合）。
- 新規スキーマ: `ArchitectureSpine` / `DesignSlice` / `IssueSpawnOrder`（本層産）。M01 共通契約モデルへ
  抽出する候補（垂直1本を通した後に共通語彙化）。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001）: D10 粒度 β（issue=PR サイズ・subArea はヒント）/ D13 M21 分離・M05 resolve 縮小 /
D14 設計二層化 / D16 AI 著者・可読性前提 / D17 human_review 層別差し戻し。

本セッション決定（2026-06-15）:

- **分解と設計の関係 = 設計主導（Tier2→issue）**。分解主導だと「先に切った issue 境界」と「設計の自然な
  境界」のズレで再分割が要るため。
- **1スライス = 1 issue（B4・正直な記録）**: これは D14 から **necessarily follow しない**——D14 は「Tier2 =
  PR サイズ・issue が保持」までで全単射までは含意しない。N:M（1スライスを複数 issue / 複数スライスを1 issue）も
  D14 と矛盾しない。本セッションが **1:1 を新規に選択**した。理由: join キー（sliceId）を issue と一致させると
  drift 逆引き・被覆検証・差し戻しが単純になる。代償として「スライスが PR サイズを超えた時の split 規約」
  （§3.2 / FR-006）が必須になり、それを明記した。
- **handoff 形式 = IssueSpawnOrder（参照集合・全 Ref 版固定）**。M21 はこの契約まで固定し、resolve の中身は M05。
  ADR §8 残 open「Tier1/Tier2 出力スキーマと resolve への引き渡し形式」を本書で確定。

敵対レビュー反映（2026-06-15・Tier B）:

- B1 被覆を双方向化 + 「AC は分割不可能・超過は M20 差し戻し」明文化 / B2 状態書き込みを M03 に委譲（FR-012）/
  B3 設計ファイル版固定 + 設計 drift 逆引き（FR-011）/ B4 1:1 を正直に記録 + split 規約 / B5 estimatedScope を
  暫定見積りとし M05→M21 サイズ差し戻し経路を新設 / C1 評価・改善トレースの接続点を §6 に追加。

独立設計レビュ追加（2026-06-15・ADR-0002）:

- **設計の独立審査点を新設**。人間は WHAT（spec/AC）のみ定義し設計は AI 著者ゆえ、実装が M07 Evaluator を
  通るのと対称に、設計も **M22 Design Reviewer**（M21 から独立）の `DesignScorecard` を spawn 前に通す（D20）。
  本層は設計の**著者・修正者**に純化（審査は持たない）。状態は `designing → design-reviewed → decomposed`（D23）。
- M22 の主務は**全体整合性**（局所品質採点でない・D21）。blocking=整合性違反、局所品質=non-blocking（D22）。
- 設計差し戻しは AC drift と**同じ逆引き機構**を再利用し該当箇所のみ再設計（D24・§4 異常系）。層3（事後トレース）
  の供給は M22 へ移譲（D25・§6）。

残 open:

- `estimatedScope` の判定基準（閾値 vs AI 判断）。**所掌は M21 の暫定見積りで確定**（B5）。実サイズは M05 resolve 後。
- ~~スライス間依存（`dependsOnSlices`）と M03 の dispatch 順の接続~~ → **確定（Tier C）**: M21 は依存
  **DAG（`dependsOnSlices`）のみ**出力。tracer-bullet 縦切り優先の順位付け・並行度は **M03 が所有**
  （スケジューリングは決定的 backbone の責務・設計段階で焼き込まない）。M03 起票時に DAG の消費方法を確定。
- Tier1 任意レビュー（`humanReview`）の粒度: 決定単位か spine ファイル単位か。
- `ArchitectureSpine` / `DesignSlice` / `IssueSpawnOrder` の M01 共通契約モデルへの抽出（垂直1本通過後）。
  各スキーマの ID 規約・version-pinned Ref・envelope は M01 抽出候補。
