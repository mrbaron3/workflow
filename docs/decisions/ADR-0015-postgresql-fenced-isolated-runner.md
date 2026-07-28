# ADR-0015: isolated runner は PostgreSQL lease と Registration fence の内側で既存 AgentOps を実行する

- 状態: 採択・吸収・構造実装済み（CISO-04）
- 親: #10／所有 Issue: #14／所有 AC: AC-CISO-006, AC-CISO-008
- 関連: [ADR-0013](ADR-0013-postgresql-control-plane-source-of-truth.md)、
  [ADR-0011](ADR-0011-standard-oci-image-and-container-runtime-adapter.md)

## 文脈

Agent 実行は provider credential、GitHub push/merge/release、repository checkout、長時間 grader を伴う。
job を process memory だけで所有すると restart 後に重複実行し、Registration の disable/version 更新または lease loss と
競合すると、古い worker が副作用を継続できる。Mac の HOME・開発 tree・SSH agent・container socket を runner へ
mount/inject すれば、repository 単位の隔離境界にもならない。一方、既存 AgentOps が持つ planning、PR-native
review/repair/test、required checks、expected-head merge、release gate を runner 側で再実装すると gate bypass を作る。

## 決定

1. `agentops-runner` は `agentops_control` schema version 3 の `FOR UPDATE ... SKIP LOCKED` queue/lease だけを入力とする。
   LISTEN/NOTIFY は wake hint、周期 reconciliation は真実回収であり、restart 時も PostgreSQL から再構成する。
2. 実行可能な payload/result/failure は `contracts/control-store/v1/runner-*.schema.json` と TypeScript の strict
   version 1 契約で共有する。job は repository/event/ref/gate identity のみを持ち、command、clone URL、credential、
   host path、任意 env を持たない。未知 version/field は terminal failure とする。
3. checkout 前（外部到達を伴うため provider boundary と同じ）、provider、push、merge、release の直前に、DB transaction
   で active lease ownership/expiry、job status、Registration version/enabled/execution_enabled を再確認する。
   allow/deny と理由を同じ transaction の `runtime_audit` へ残す。side effect wrapper は短命・単回の permit を実際の
   push/merge/release 呼出しで消費し、heartbeat loss は以後の side effect を停止する。
4. runner は既存 `runGithubDevelopmentTurn`、planning/UI/generator/perspective、PR-native reconciliation を adapter
   として呼ぶ。新しい merge shortcut は作らず、current-head review/repair/test、required checks、expected SHA、
   merge、release の既存順序を保存する。
5. workspace は runner-only volume の
   `/workspace/registrations/<registration-id>/jobs/<job-id>/attempt-<n>` へ決定論的に作り、mirror/worktree/state/artifact
   lifecycleを同じ Registration root に閉じる。PostgreSQL へは `volume://registrations/...` URI、SHA-256、size、
   createdAt だけを記録し、読取時に digest/size と real path containment を再検証する。
6. OCI `runner` stage は uid 65532、専用 HOME、private volume、zero host port、read-only root filesystem、capability dropを
   前提とする。起動時に named mount、HOME/cwd、published ports、DB/GitHub/選択 provider だけの outbound allowlist、
   credential separation、SSH/container/control socket 不在を fail closed 検証する。子 process env は GitHub と選択
   provider credentialだけに縮小し、DB/control credentialを渡さない。
7. evaluation domain の `.harness/db.json` は既存 AgentOps adapter の Registration-private state として保持するが、
   control-plane PostgreSQLへ複製せず schema も変更しない。control-plane の唯一の SoT は引き続き PostgreSQL である。

## 帰結

- Registration 更新、lease expiry/loss、worker restartのいずれでも、古い owner は次の critical boundary で停止する。
- provider 実行中そのものは取り消せないが、その後の push/merge/release は許可されず、attempt/audit が復旧判断を残す。
- safe smoke は external side effectを発生させず、既存 gate adapter seamを全 boundaryまで通し、実 runner processでは
  unknown schema/artifact tamperを拒否する。外部 provider/GitHub の実credentialを使う release rehearsal は後続統合で行う。
- outbound allowlist は runner の宣言契約であり、production topology は同一集合を network policy/proxyでも強制する。
  CISO-04 Apple smoke は internal networkで外部到達を全面禁止し、無権限 side effectが起きないことを優先する。

## 実装先 id

- architecture: `ARCH-control-store-009`〜`011`、`ARCH-container-runtime-008`〜`010`
- domain-model: `DOM-control-store-007`〜`009`、`DOM-container-runtime-009`
- data-model: `DATA-control-store-012`〜`014`、`DATA-container-runtime-006`
- ubiquitous-language: `LANG-control-store-011`〜`015`、`LANG-container-runtime-010`〜`012`
