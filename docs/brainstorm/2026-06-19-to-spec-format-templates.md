# ブレスト: to-spec を自己完結化（テンプレを assets/ へ移設・format.md 廃止・MR 概念廃止）

- 日付: 2026-06-19
- ステータス: 方向性決定

## 目的（何をなぜ）

- `to-spec` skill の書式規約が `references/format.md` に「縮約再掲」されており、root
  `templates/` のテンプレと二重持ち＝drift 源。テンプレは既に**自己説明的**なので format.md は不要。
- **正式 spec は to-spec で生成する**方針（兄弟ブレスト②）に合わせ、to-spec を**自己完結・配布可能**な
  skill にする。著述に使うテンプレは **skill が `assets/` 配下に自前で持つ**構成へ。
- 併せて、to-spec が既に「自動採点不能はチャットで指摘」に一本化している実態に合わせ、
  **manual-requirements.md（MR-ID）概念を廃止**し、孤児テンプレと食い違う言及を一掃する。

## 重要な事実確認

- **コードはテンプレ「ファイル」を読んでいない。** `src/authoring/{lint,fingerprint}.ts`・`resolve.ts`・
  `check-spec.ts` が触る `acceptance.yaml` は **epic dir の生成物**（テンプレ `templates/acceptance.yaml`
  ではない・同名別物）。`src/agents/prompts.ts` の `loadTemplate` は**呼び出しゼロ**。
  → テンプレ移設でコードは壊れない。写経の消費者は to-spec の SKILL.md 指示だけ。
- **manual-requirements.md は孤児**: to-spec は生成しない（チャットで指摘）。lint.ts は MR ファイルを
  読み書きせず、「acceptance.yaml に manual method を入れない」だけを enforce（コメントで MR に言及するのみ）。
- ただし **feature-spec.md / acceptance.yaml 本文は今も「manual-requirements.md へ分離」と記述**しており、
  skill（チャット指摘）と食い違う drift がある。

## 規約との関係（衝突ではなく住処の移動）

- CLAUDE.md「skill 配下に**複製**しない」が禁じるのは duplication。今回は root から**移設**（root コピー削除）
  なので DRY は保たれ、単一住処の location が skill へ動くだけ。
- 「配布可能プラグインへ切り出す場合のみバンドル（将来）」を to-spec で**今**始める。
- root に残す `labels.yaml / roadmap.yaml / issue-contract.md / scorecard.yaml / epic.md` は
  他モジュール/コード共有資源 → root `templates/` 据置。

## 制約・前提

- `SKILL.md` を変えたら `SKILL.md.ja` も同時更新（CLAUDE.md 著述規約）。
- `.md` 編集後 markdownlint（pre-commit hook）。
- 検査不変条件（双方向被覆・AC-ID 重複禁止・manual 禁止）は **check-spec.ts / lint.ts が SoT**（別置きしない）。

## 成功基準

- to-spec が `assets/`（feature-spec.md / acceptance.yaml）+ `scripts/` + `SKILL.md`/`.ja` で**自己完結**。
- format.md と manual-requirements.md が消え、テンプレ本文・lint コメント・skill が「チャットで指摘」で**整合**。
- `npm test` / `typecheck` 緑（コードはテンプレ未参照・MR ガードの挙動は不変）。

## 決定事項

- 不変条件の置き場 = **コードが SoT**（別 references を作らない）。
- ルール変更の射程 = **to-spec 限定**（他 skill は現状維持）。
- manual-requirements = **概念ごと廃止**（チャット指摘へ一本化）。ただし `manual` enum 値と
  `checkManualAbsence` ガードは**保持**（acceptance.yaml を自動採点専用に保つ機構）。schema からの
  `manual` 除去は別件・非ブロッカー。

## 実施内容（次アクション）

1. `.claude/skills/to-spec/assets/` を作成し **git mv** で移設（**2枚のみ**）:
   - `templates/feature-spec.md` → `assets/feature-spec.md`
   - `templates/acceptance.yaml` → `assets/acceptance.yaml`
2. `templates/manual-requirements.md` を**削除**。
3. `assets/feature-spec.md` 本文を修正: 「自動採点不能は manual-requirements.md へ分離/移す」（旧18・70行）→
   「自動採点不能な要件はチャットで人間に指摘し、人間が扱いを判断する」。
4. `assets/acceptance.yaml` 本文を修正: 「manual は禁止（…manual-requirements.md へ）」→
   「manual は禁止（自動採点不能はチャットで人間に指摘・人間が判断）」。
5. `src/authoring/lint.ts` のコメント（15・60行）から MR ファイル参照を除去（挙動は変えない）。
6. `.claude/skills/to-spec/references/format.md` を削除（references/ が空なら dir も削除）。
7. `SKILL.md` / `SKILL.md.ja` を更新: 写経参照を `assets/...`（skill 相対）へ、format.md ポインタ削除。
8. **CLAUDE.md「資源の住処」改訂**（to-spec 限定）:
   - 「単一 skill 専用テンプレはその skill の `assets/` を単一住処／コード・複数 consumer 共有は root」。
   - 「相対パス禁止」に「skill 自身のバンドル資源（assets/）は skill 相対参照を許容」を補足。
9. `npm test` / `npm run typecheck` / markdownlint。

## 未解決の問い（非ブロッカー）

- `VerificationMethod` enum からの `manual` 除去（+ それに伴う `checkManualAbsence` の整理）は別件。
  今回は挙動保持のため保留。
- docs/spec（特に authoring-layer.md）は MR-ID 設計を多く含むが、②で draft/_spec へ移動し to-spec で
  再著述する際に MR 廃止を反映する。今回 draft 側は scrub しない。
- ADR-0005（梱包方針）との整合は②の draft 化後に取る。

## 関連

- 兄弟ブレスト②: docs/spec → draft/_spec 降格・正式 spec は to-spec で生成
  （2026-06-19-docs-spec-to-draft.md）。
