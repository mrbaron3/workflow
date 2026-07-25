# PR #9 — リポジトリ起点 Webhook／PR ゲート引き継ぎ

更新日: 2026-07-23  
対象 PR: [mrbaron3/workflow#9](https://github.com/mrbaron3/workflow/pull/9)

## 1. 停止点

作業は、PR #9 の r42 指摘を修正して commit・push し、対象テストまで通した時点で意図的に停止している。

- PR head: `5070329ab0486df4434f26348c680debb6ba1636`
- branch: `feat/pr-native-webhook-control-plane`
- generator worktree: `.harness/worktrees/issue-0024-s0`
- generator worktree は clean
- `npm run typecheck`: 成功
- 対象 48 tests: 成功
- 最新 head での全テスト: **未実行**
- 最新 head に対する r43 の 6 観点レビュー: **未実行**
- PR #9: OPEN / draft / MERGEABLE、status check なし
- webhook daemon の新インスタンス: **停止中**（port `8378` は空き）

重要: 「キリのいいところで止める」というユーザー指示を維持すること。再開後も、全テスト、再レビュー、指摘修正、マージなどの自然な境界ごとに一度停止して結果を報告する。無断で連続した修正ループや次タスク生成へ入らない。

## 2. ユーザーが求めている動作

登録単位は特定の PR や issue ではなく、**リポジトリそのもの**。

1. poll または webhook が登録済みリポジトリの PR を発見する。
2. PR の正確な head SHA と remote base SHA を固定する。
3. 決定論的検査と、独立した 6 観点レビューを行う。
4. 承認が付いていても P0 / P1 / major / blocker があればゲートを通さない。
5. 指摘を修正し、同じ head を前提にせず新 head へ再レビューする。
6. 全ゲート通過後だけ expected-SHA 付きでマージする。
7. merge 後に issue を release し、依存が解消した次タスクを次回 poll の候補にする。

PR #9 がこの制御面を実装している。ユーザーは「ゲート通過後の PR #9 のマージ」を承認済みだが、現 head はまだ再レビュー前なので今すぐマージしない。

## 3. r39〜r42 の履歴

### r39 → `ff34175`

- review diff の base がローカル `main` だった問題を修正。`origin/<base>` を fetch・解決し immutable SHA を渡す。
- `changes-requested` revision が approval binding を生成できる問題を型と runtime の両方で禁止。
- retry が再失敗しても API / UI が成功表示する問題を、`409` と `lastError`、GUI の失敗表示へ修正。

### r40 → `a64ec4d`

- 設定保存後にフォーカスが非表示要素へ残る accessibility 問題を修正。
- 可視 edit button へ戻し、reconcile fallback と DOM test を追加。

### r41 → `9b464c5`

大きすぎる schema / review / UI モジュールを以下へ分割し、旧 module からの re-export 互換を維持した。

- `src/domain/agent-runtime.ts`
- `src/domain/pr-schema.ts`
- `src/domain/pr-lifecycle.ts`
- `src/pipeline/execution/restricted-review.ts`
- `src/pipeline/execution/review-liveness.ts`
- `src/pipeline/execution/review-session-runner.ts`
- `src/webhook/ui-client.ts`
- `src/webhook/ui-styles.ts`

### r42 → `5070329`

r42 では type-design と test-quality に major があり、他 4 観点は approved だった。

- retry progress が immutable な registration / consumer plan に結び付いていなかった問題を修正。
  - `WebhookRoutePlan` に `registrationId` と planned consumers を保持。
  - failed → pending retry でも同一 plan を維持。
  - completed consumer が plan に属することを検証。
  - routed / unrouted pending を分離。
  - partial failure 後に repository consumers が変更されても、旧 plan の未完 consumer を実行し、完了済み consumer を再実行しない回帰テストを追加。
- AC-PRAUTO-003 の不足を修正。
  - dependent issue を seed。
  - merge 前は `pollable` に存在せず、release 後の次 poll で候補になることを統合テストで確認。

commit: `5070329 fix: retry経路と次タスク選択を固定`

## 4. 検証済みの証拠

`5070329` では次が成功済み。

```text
npm run typecheck
test/webhook-inbox.test.ts
test/webhook-control-server.test.ts
test/pr-native-gate.test.ts
合計 48 tests
```

直前の `9b464c5` では全 suite（85 files / 686 tests）が成功していた。ただし、これは最新 head の全テスト成功を意味しない。

store 上の最新レビューは `PR-0019` / `PRREV-0043` / ordinal 42（表示 r42）、head `9b464c5`。次の review は通常 `PRREV-0044` / r43 になる。

## 5. 再開手順

### 5.1 最新 head を独立 runtime で検証

root の未コミット変更を混ぜないため、`5070329` から detached runtime を作る。

```sh
git worktree add --detach .harness/runtime/review-5070329 5070329
cp -cR .harness/runtime/review-9b464c5/node_modules .harness/runtime/review-5070329/node_modules
cd .harness/runtime/review-5070329
git rev-parse HEAD
git status --short
npm run typecheck
npm test
```

必ず `review-5070329` を workdir にして実行する。以前、root から誤ってテストしたことがある。

全 suite の成否を報告し、ここを一つの停止点とする。

### 5.2 PR #9 だけを再レビュー

daemon や `github-turn` は generator queue へ入り得るため使わない。独立 runtime から review-only 呼び出しを使う。

```sh
./node_modules/.bin/tsx -e '
import path from "node:path";
import { loadConfig } from "./src/config.ts";
import { Store } from "./src/store/store.ts";
import { realPrNativeGithubRunner } from "./src/pipeline/execution/pr-native.ts";
import {
  discoverRepositoryPullRequests,
  reviewRepositoryPullRequest
} from "./src/pipeline/execution/repository-pr.ts";

void (async () => {
  const root = "/Users/yu/Company/Development/workflow";
  const config = loadConfig(root);
  if (!config.target) throw new Error("target is required");
  const store = new Store(root);
  const runner = realPrNativeGithubRunner(config.gate?.mergeMethod);
  const targetRoot = path.resolve(root, config.target.repo);
  const discovery = discoverRepositoryPullRequests(
    store,
    config,
    runner,
    targetRoot
  ).find((row) => row.pullRequest.number === 9);
  if (!discovery) throw new Error("PR #9 was not discovered");
  console.log("REVIEW_START", JSON.stringify({
    prId: discovery.pr.id,
    revisionId: discovery.revision.id,
    headSha: discovery.revision.headSha,
    ordinal: discovery.revision.ordinal,
    reviewRequired: discovery.reviewRequired
  }));
  const result = await reviewRepositoryPullRequest(
    store,
    config,
    discovery,
    runner,
    root,
    console.log
  );
  console.log("REVIEW_RESULT", JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'
```

証拠は通常 `.harness/review-evidence/issue-repository-pr-9-r43/` に出る。aggregate だけで判断せず、6 観点すべての findings を確認する。

P1 / major / blocker が一件でもあれば、そこで停止して指摘内容を報告する。自動的に次の修正ラウンドへ進まない。

### 5.3 ゲート通過後のマージ

6 観点、決定論的検査、head SHA を確認できた場合だけ:

1. `gh pr ready 9 --repo mrbaron3/workflow`
2. exact runtime から `reconcilePrNativeGates` を使い、expected SHA `5070329ab0486df4434f26348c680debb6ba1636` で harness の merge 経路を通す。
3. GitHub 上で `MERGED` を確認する。
4. 対応 issue が released になったことを確認する。
5. 依存 issue が次回 poll で `pollable` になったことを確認する。
6. 結果を報告し、daemon 起動や次タスク生成へ進む前に停止する。

マージ前に head が変わっていたら expected SHA を更新して押し切らず、再検証・再レビューする。

## 6. Webhook 登録と daemon

- root `.harness/webhooks.json` に `mrbaron3/workflow` の repository-level registration がある。
- 特定 PR / issue を登録する設計ではない。
- registration は enabled、consumer は agentops、対象イベントが設定され、base は `main`。
- 新 daemon 用の port `8378` は空いている。
- `/Users/yu/Company/Development/bin/octolink-webhook-daemon.py` の既存 daemon が `8377` で動いている可能性がある。別用途なので停止・変更しない。

PR #9 の merge と状態確認を終えるまで、新 daemon を起動しない。

## 7. 触れてはいけない未コミット変更

root worktree にはユーザー所有の別作業がある。PR #9 の generator worktree とは分離されているため、上書き、破棄、commit、stash をしない。

```text
 M docs/NORTH_STAR_PLAN.md
 M docs/_system/evaluation/architecture.md
 M docs/_system/evaluation/ubiquitous-language.md
 M docs/decisions/README.md
 M src/pipeline/execution/live.ts
 M src/pipeline/execution/perspective-session.ts
 M src/pipeline/execution/repository-pr.ts
 M test/perspective-session.test.ts
?? docs/decisions/ADR-0011-surrogate-verifier-oracle-calibration.md
?? src/pipeline/verification-signal.ts
?? test/verification-signal.test.ts
```

この引き継ぎ文書自体も root の未コミット変更として残す。ユーザーの明示指示なしに commit しない。

## 8. 今後の計画

PR #9 のゲート通過・merge 後、別の自然な作業単位として以下を計画する。

- 複数リポジトリを GUI から追加・編集・無効化できる汎用 webhook daemon。
- macOS ローカル固定を外した実行・永続化・運用方式。
- webhook と poll の重複配送、再送、consumer plan の可観測性。
- daemon shutdown と generator queue の境界を明確化し、意図せぬ長時間セッションを防ぐ。
- 各ラウンドの開始・完了・停止点を GUI とログで明示する。

これらは PR #9 の再レビューを省略する理由にはしない。また、PR #9 の merge と同じ連続セッションで自動着手しない。
