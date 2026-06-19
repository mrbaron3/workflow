# ブレスト: docs/spec を draft 扱い（draft/_spec/）へ移し、正式 spec は to-spec で生成

- 日付: 2026-06-19
- ステータス: 方向性決定

## 目的（何をなぜ）

- 今の `docs/spec/`（ハーネスのモジュール詳細仕様 M01–M22。全モジュール「下書き」状態）を、
  正式な確定仕様ではなく **draft（下書き入力）** として明確に位置づけ直す。
- 動機（決定的）: **正式な spec は、いま整備中の `to-spec` スキル（著述層 / M20）で生成したい**。
  ハーネス自身のモジュール仕様を、ハーネスの著述層で正式 spec（spec.md + AC-ID + acceptance.yaml）
  として作る——ドッグフーディング。
- よって今の手書き docs/spec は「to-spec の Intake が読む上流決定 doc」に格下げし、physical な location で
  draft であることを示す。

## 制約・前提

- `draft/` は draft-spec skill の世界（`draft/<feature>/`・`draft/overview.md`・F-ID・実装詳細禁止）と、
  brainstorming の `draft/_brainstorm/` が住む。モジュール詳細仕様を直に置くと altitude が衝突するため、
  `_` 接頭のメタ領域に**隔離**する（`_brainstorm` 慣習に倣う）。
- `REQUIREMENTS.md` は要求の**正本**。root に残す（移動しない）。
- to-spec の Intake は上流決定 doc を SoT として読む（SKILL.md step 1）。draft/_spec はその入力源になる。
- `.md` 編集後 markdownlint（pre-commit hook）。

## 成功基準

- docs/spec が空になり、中身は `draft/_spec/` に移って「draft（未確定・to-spec で正式化予定）」と読める。
- 外部リンク（6 ファイル）と内部相互リンクが切れない。
- 正式 spec は to-spec 経由で生成する、という意図が README に明記される。

## 採用する構造

```text
draft/
  _brainstorm/        ← ブレスト結果（既定）
  _spec/              ← ★ 今の docs/spec を丸ごと移設
    README.md
    modules/*.md       （authoring-layer / design-planner / design-reviewer / issue-contract-planner）
    loop1-walkthrough.md
    decisions/*.md      （ADR-0001〜0005 も一緒に移す）
  <feature>/          ← draft-spec のプロダクト機能（将来）
  overview.md         ← draft-spec の見取り図（将来）
REQUIREMENTS.md       ← 正本。root に据え置き
```

### 決定事項

- ADR（decisions/）も **一緒に** draft/_spec/ へ移す。理由: ADR は未構築システムを記述した未検証の設計群で、
  仕様が常時 ADR を参照する。同一ツリーに置くと参照が閉じ、cross-tree 参照を避けられる。
- REQUIREMENTS.md は移さない（正本）。

## 検討した案（draft 配下の置き方）

- 案 A（採用）: `draft/_spec/` 専用サブツリーへ丸ごと移設（構造保持）。
  - 利点: draft-spec の F-ID/overview 世界と混ざらない。location で draft を示す。移行が単純。
  - 欠点: draft/ に住人が増える（が `_` 接頭で区別済）。
- 案 B: `draft/` 直下へモジュールを散開。
  - 欠点: overview.md/F-ID の世界と衝突。draft-spec のガードレールと混線。却下。
- 案 C: draft-spec の F-ID/overview モデルへ作り替え。
  - 欠点: altitude が違う（実装詳細禁止ガードレールに反する）。大改修。却下。

## 実施内容（次アクション）

1. `git mv docs/spec draft/_spec`（履歴保持）。`docs/spec/` を空にする。
2. 外部参照 6 ファイルの `docs/spec/...` → `draft/_spec/...` を更新:
   - CLAUDE.md / REQUIREMENTS.md / docs/ARCHITECTURE.md / docs/GLOSSARY.md /
     templates/issue-contract.md / templates/roadmap.yaml
   - （to-spec/references/format.md は別ブレストで削除予定のため対象外）
3. 内部相互リンク（draft/_spec/README.md・decisions/0001）を新パスへ追従。
4. `draft/_spec/README.md` の位置づけ文言を更新: 「確定していく作業台／実装を仕様に合わせる」→
   「**draft（未確定）入力。正式 spec は to-spec で生成する**」趣旨を明記。
5. markdownlint。

## 未解決の問い（非ブロッカー）

- **to-spec が生成する正式 spec の住処**: spec.md + acceptance.yaml を epic ディレクトリのどこに置くか
  （空いた docs/spec/ を正式 spec の home に再利用するか、別 location か）。実際に to-spec を回す時に決める。
- 移行は format.md 削除ブレスト（[2026-06-19-to-spec-format-templates.md](2026-06-19-to-spec-format-templates.md)）
  と独立に実施可。順序依存は format.md の docs/spec 参照のみ（format.md 削除で自然消滅）。

## 関連

- 前提を強める文脈: 著述層（M20）を to-spec スキルで正式化する方針。
- 兄弟ブレスト: format.md → テンプレ一本化（2026-06-19-to-spec-format-templates.md）。
