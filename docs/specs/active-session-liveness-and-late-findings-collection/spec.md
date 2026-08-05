# 活動セッションの liveness と遅延 findings 収集 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「働いているセッションを殺さず・止まったセッションを黙らせず・
> 遅れて届いた証拠を捨てない」という liveness/収集の観測可能な性質。monitorLiveness / 収集処理の関数形・
> 注入 seam の設計は実装の裁量（ただし判定は決定論テスト可能にする — 非機能要件）。
>
> **背景（⑤の grounded 失敗）**: review の hardCap は 10 分だが、testQuality レビュアが APFS clone 上で
> 6 ミューテーションを実走する正当な徹底レビューに 1h26m を要した。現実装の timeout は「経過 > hardCapMs
> なら pane の活動を無視して発火」で、しかも idle なら先に stuck（90 秒）が発火するため、**timeout は実質
> 「活動継続中のセッションにだけ」発火する**＝意味論と値の不整合。遅れて完走した findings（approve 1.0）は
> 収集されず、人間ゲートが手動検分で回収した。
>
> **参照する固定制約**: `ARCH-execution-014`（liveness モニタ/surfacing — stuck は kill せず顕在化）／
> `ARCH-execution-015`（never-silent: セッションは静かに終了しない）／`DOM-execution-005`（完了は sentinel
> のみで確定）／[NORTH_STAR](../../NORTH_STAR.md)（同じ失敗を二度繰り返さない）。dependsOn は
> acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Active-session liveness and late findings collection
- outcome（価値・なぜ今）: 活動継続中（pane 変化あり）のレビュー/生成セッションが短い hardCap で timeout 扱いにならず（有限の絶対天井までは待つ）、stuck/timeout 判定後でも収集時点で存在する findings は捨てられない。⑤の grounded 失敗（1h26m の正当なミューテーション検証レビューが 10 分 cap で失われ人間介入を要した）を封じ、徹底レビューの証拠を評価ループへ回収する。
- 計画の木リンク: feature=FEAT-003 epic=EPIC-01

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| LIVE-A | 活動延命（働いているセッションを timeout で殺さない・ただし有限） | 高 |
| LIVE-B | 遅延 findings 収集（判定後に存在する証拠を捨てない） | 高 |

## LIVE-A 活動延命

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・パネル招集）
- 何を: pane が変化し続けている（＝現に働いている）セッションを、短い hardCap の経過だけで timeout に
  しない。活動があっても有限の絶対天井では必ず打ち切る
- なぜ: timeout は idle なら先に stuck が発火するため、実質「働いているセッション」にしか発火しない。
  正当な徹底レビュー（ミューテーション検証等）ほど長く働くので、短い cap は**良い評価ほど捨てる**逆選別に
  なる。一方で無限待ちはコスト無限＝never-silent の反対側の失敗であり、天井は有限でなければならない

**受け入れ基準**

- **[AC-LIVE-001] 正常系: 活動継続中のセッションは hardCap を超えても完走できる**
  - Given セッションの pane が変化し続けており（作業指標あり）、経過時間が hardCap を超えたが
    活動天井（activeCap・有限）には達していない
  - When liveness を監視する
  - Then timeout にならず監視が継続し、その間に sentinel が現れれば completed になる（⑤の実例:
    10 分 cap を超えて働いた 1h26m のレビューの findings が失われない）

- **[AC-LIVE-002] 異常系: 有限性と stuck 検知は保たれる**
  - Given (a) セッションが活動を続けたまま活動天井（activeCap）を超えた、または (b) pane が idleMs の間
    変化せず sentinel も無い
  - When liveness を監視する
  - Then (a) は timeout、(b) は従来どおり stuck になる（どちらも store へ昇格され人間へ顕在化する —
    無限待ち・無言破棄はしない）

## LIVE-B 遅延 findings 収集

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・パネル収集）
- 何を: stuck / timeout と判定した review でも、収集の時点で findings（sentinel）が既に存在すれば
  それを中央 evalRoot へ収集する
- なぜ: 判定と完走の間には本質的に race がある（⑤では判定の 16 分後に完走）。判定時刻のスナップショットで
  証拠を捨てるのは false-negative であり、収集時点の事実（ファイルが在る）が正

**受け入れ基準**

- **[AC-LIVE-003] 正常系: 判定後に存在する findings は収集される**
  - Given ある review が stuck / timeout と判定されたが、収集の時点でその review の findings
    （sentinel ファイル）がディスク上に存在する
  - When findings を収集する
  - Then その findings は completed の review と同様に中央 evalRoot へ収集され、パネルの採点に使われる。
    checkout を汚した review の discard ガード（read-only 強制）は引き続き適用される

**非機能要件**

- 決定論: liveness 判定・収集判断は注入 seam（時計・pane 取得・sentinel 存在確認・sleep）で
  決定論テスト可能にする（実 tmux/実時間なしで全分岐を検証できる）。
- 可観測性: completed / stuck / timeout・遅延収集の別は log と store から監査できる。

**完了条件**

- 自動テスト: 正常（活動延命→完走・遅延収集）／異常（活動天井 timeout・idle stuck・discard ガード維持）を
  各 1 以上。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- escalate を消さない: stuck / timeout の store 昇格・人間への顕在化（kept-alive）は本機能の後も残る。
- 無限待ちを導入しない: 活動天井は必ず有限（既定値を持ち・設定可能）。
- sentinel 以外で完了を確定しない（`DOM-execution-005`: pane の見た目を完了判定に使わない）。
- 合格基準（既存テスト）を弱体化しない。
