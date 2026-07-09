# ドキュメント・ライフサイクル方針

> 仕様駆動開発で生む全文書を「どの層に・どの時間モードで」置くかを定める地図。
> 「これはどこに書くべき / これは SSOT か派生物か」で迷ったらここを引く。
> 個別の整合規約・lint は各 skill の `scripts/check-*.ts`（決定論はコードへ）が持ち、本書は**判断**だけを書く。

- 種別: harness / policy
- 状態: 確定（案A＝派生ビューを採用）
- 最終更新: 2026-06-28
- 関連: [NORTH_STAR.md](../NORTH_STAR.md) / [DOC_TAXONOMY.md](DOC_TAXONOMY.md) / [ARCHITECTURE.md](../ARCHITECTURE.md) / [GLOSSARY.md](../GLOSSARY.md)

## なぜこの方針が要るか

要求の粒度はフェーズで変わる（システム規模／機能／バグ）。素朴に「to-spec の成果物＝アプリの仕様書」と
扱うと破綻する。理由は2つ：

1. **時間モードが違う。** `requirements.md`（旧名 spec.md）は *as-designed*（変更意図・署名された WHAT 契約）であり、変更にスコープ
   された **delta**。アプリの「現在仕様」は *as-built*（実際に成り立っている挙動）という **状態** の概念で、
   両者は別物。
2. **後勝ちで上書きされる。** 後の spec が前の spec の AC 挙動を置換しうる。署名 spec を時系列に並べても
   「現在の仕様」にはならない（イベントログ ≠ 現在状態）。流れを畳まないと状態は出ない。

→ **「アプリの仕様書」は著述する対象ではなく、署名 spec の流れを畳んだ projection（派生ビュー）である。**

## 2つの軸

文書は **altitude（高度）× time-mode（時間モード）** で分類する。

- **altitude**: macro（system 全体で共有）↔ micro（1機能）↔ nano（1 PR/タスク）。
- **time-mode**: **delta（流れ）**＝要求から生まれ変更にスコープされ履歴として積もる ／
  **state（蓄積／SSOT）**＝現在の真実、継続的に reconcile される。

| | **delta（流れ）** | **state（SSOT／蓄積）** |
|---|---|---|
| **macro（system）** | `design-delta.md`（reads/extends + 影響 AC-ID） | ✅ **system 層**: `_system/<ctx>/domain-map.md`・`architecture.md`・`data-model.md`（additive・生きている） |
| **micro（機能）** | ✅ **`requirements.md` + `acceptance.yaml`**（署名・版固定された WHAT 契約。旧名 spec.md — 2026-07-09 改名・凍結置台は旧名のまま） | 🟡 **現在成り立つ AC 集合**（=「アプリの現在仕様」。**派生ビュー**。§派生ビュー参照） |
| **nano（PR/タスク）** | **Issue Contract**（store）・PR・repair brief・eval run（実行レコード・著述文書でない） | ✅ **コード + green な evidence / scorecard**（as-built の真実） |

macro 状態（system 層）も nano 状態（コード+evidence）も既にある。**唯一 派生で埋めるのが micro 状態**。

## 著述する SSOT は2つだけ

複製は drift する（[NORTH_STAR](../NORTH_STAR.md) の反証）。だから**手で書いて維持する SSOT は次の2つに限る**：

1. **system 層（macro 状態）** — `to-system-design`。境界コンテキスト単位、**additive only**（ID 不変・追加のみ・
   renumber/rewrite しない）。恒久的なドメイン／アーキ／データの真実はここに積もる。
2. **署名 spec（micro delta）** — `to-spec`。粒度非依存の WHAT 契約。署名で `contract-approved`／`ApprovedSpecRef`
   として版固定される。**これは状態ではなく delta**——「現在仕様」と混同しない。

その他はすべて **delta（履歴）** か **派生物**。新規の著述 SSOT を増やさない。

## 派生ビュー：「アプリの現在仕様」（案A）

micro 状態は**ファイルとして手書きしない**。図・シーケンス図と同じく「下流で derive」する（3 skill 共通の
「Diagrams are derived downstream, not authored here」と一貫）。

```text
署名済み spec の acceptance.yaml（AC 群）   = イベントログ（実装された WHAT 契約の流れ）
   │  fold（supersede を解決し、現在成り立つ AC だけ残す）
   ├─►  system 層（domain/arch/data）        = macro の materialized view（著述・additive）
   └─►  「現在成り立つ AC 集合」              = micro の materialized view ＝「アプリの現在仕様」（派生）
```

- **source（spec）と projection（catalog）を取り違えない。** 署名 spec（`requirements/<f>/`・旧 `specs/<f>/`）は**永続・git 管理**
  （署名で gitSha 固定・drift 検知の基準）＝**ログ（source）**。feature-catalog は `_derived/` の**派生（projection）**。
  *commit を消して CHANGELOG だけ残す*ことをしないのと同様、spec を消して catalog だけ残さない。
- 人間可読の「機能カタログ」が欲しければ、この AC 集合から**生成して焼く**（手書きの第4層を作らない）。
- **欠落部品（前方参照・未実装）**: 流れを機械的に畳むには spec/AC 間の **`supersedes` エッジ**（どの過去 AC を
  置換するか）が要る。これが無いと「どの歴史 AC がまだ生きているか」を決定的に判定できない。小さく決定的なので
  `src/` 側の決定論ロジックとして実装する（[ARCHITECTURE](../ARCHITECTURE.md) の store を SoT とする方針に乗せる）。

## 要求粒度 → 入口（SSOT は一つ）

粒度は**入口**を決めるだけ。行き着く SSOT は同じ。

| 粒度 | 入口 | SSOT への作用 |
|---|---|---|
| **システム規模（製品）** | ① `to-system-design` で macro を据える（top-down）＋ ② **roadmap が epic→feature に分解** → ③ **feature ごとに to-spec**（1つの巨大 spec にしない） | system 層を著述／拡張 ＋ 複数の署名 spec |
| **機能ベース** | **`to-spec`**（既存 system 層を参照）。新ドメイン/データが要れば `to-system-design` で additive 拡張 | spec を1本追加（＋必要なら system 層を additive 拡張） |
| **バグ修正** | 小さな spec、またはより良く **eval 回帰ケース**へ昇格（[NORTH_STAR](../NORTH_STAR.md):「同じ失敗を二度繰り返さない」） | AC を1本（回帰）追加。macro は通常動かさない |

SSOT は **2方向**で更新される：**top-down（著述）**＝大きな要求が system 層を据える／**bottom-up（蒸留）**＝
実装済み spec から恒久的事実を system 層へ吸い上げ、機能挙動は AC 集合へ畳む。additive-only なので
どちらでも**書き換えずに真実が積もる**。

**spec の粒度上限**: 1 spec = 1つの凝集した署名可能 capability。製品スケールはこれを超えるので **roadmap が
feature へ分解**し、各 feature を to-spec が清書する（分解＝計画の木、清書＝to-spec）。詳細は
[DOC_TAXONOMY](DOC_TAXONOMY.md) §2本の木。

## 一周の回し方

```text
要求 ──► ① 分類（altitude × time-mode：どの層の delta か）
      ──► ② 該当層を著述/拡張（macro: to-system-design[additive] / micro: to-spec）
      ──► ③ 署名（contract-approved＝WHAT 確定。人間の判断点）
      ──► ④ to-detail-design が Issue（PR サイズ）を生成（被覆×排他で AC 全カバー・store に着地）
      ──► ⑤ 自律実装（agent が HOW）→ PR
      ──► ⑥ 評価（grader → scorecard + evidence＝build-approved）
      ──► ⑦ ★蒸留：恒久的事実は system 層へ吸い上げ、機能挙動は AC 集合へ畳む（supersede 解決）
      ──► ⑧ 失敗は eval 回帰へ昇格（Curator）／ プロセス改善（Analyst）↺
```

⑦ が「to-spec で計画・実装し、それらから蒸留したものがアプリ仕様書になる」の置き場所。
**新規著述ではなく derive（畳み込み）**として置く。

## コードが守るべき不変条件（決定論はコードへ）

本書は判断のみ。次は将来 `scripts/check-*.ts` / CI 側で機械強制する候補：

- **著述 SSOT の二重化禁止**: system 層の内容を spec へ複製しない（参照のみ）。spec を「現在仕様」として
  直接参照しない（必ず派生ビュー経由）。
- **additive only**: `DOM/ARCH/DATA-NNN`・AC-ID は不変・追加のみ。
- **fold 可能性**: `supersedes` エッジが揃っていれば、現在成り立つ AC 集合は spec 群から決定的に再生成できる
  （同入力→同出力）。
