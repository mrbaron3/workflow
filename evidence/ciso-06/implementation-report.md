# CISO-06 `agentopsctl` lifecycle 実装・検証証跡

- Issue: `mrbaron3/workflow#16`
- immutable base: `ba79d1f0e02fb71e23774db15dcde81190b735de`
- ADR: `docs/decisions/ADR-0016-agentopsctl-lifecycle-authority.md`
- control schema: version 4

## 実装

Goの短命CLI `agentopsctl start|drain|stop|status|logs|open`を追加した。Apple Container adapterは
ownership label付きnetwork/volume/containerだけを操作し、controlだけをexact loopbackへpublishする。
runner/PostgreSQLはhost-only network内部だけで動き、controlのCONNECT allowlistがGitHub/GitHub API/選択providerの
HTTPSだけをbridgeする。runtime argv/errorはcredential値をredactし、control/runner/PostgreSQL DB credentialと
control/runner GitHub credentialを分離する。

schema version 4は`lifecycle_state`と`lifecycle_transitions`を追加した。明示mode graph、unique idempotency key、
rejected/idempotent/applied audit、drain deadline/timeout/last errorをPostgreSQLへ保存する。同一keyはactor、target、
microsecond-normalized drain deadline、canonical detailsが一致するcurrent transitionだけをreplayし、semantic conflictと
stale replayを拒否する。DRAINING transitionとdelivery routing/enqueue/leaseはrow lockで直列化し、direct job INSERTの
trigger自身も同じsingleton rowへ`FOR SHARE`を取ってACTIVE判定とcommitをrace-freeにする。

drainはDRAINING commit後にrunnerへSIGTERMを送り、lease/attemptがゼロかつrunner停止まで待つ。timeout時はforce killせず
failureを保存する。controlを再作成しないため、runnerが参照中のproxy address/tunnelはdrain完了まで安定する。
restartはpersisted mode/lease/attemptとactual topologyを照合し、欠損ACTIVEをDRAININGへ寄せる。crash後に期限切れとなった
leaseはowner-only reconciliationがattemptをtimed_out、leaseをexpired、jobをretry/terminalへ原子的に回収して監査する。
partial start補償はpreflight後のmutation receiptだけを対象にし、DBがACTIVE/DRAININGなら監査付きDRAININGを維持し、
execution前なら元のOFF/MONITOR_ONLYを復元する。control/runnerはimmutable image descriptorとsecret値を含むdesired
environment、entrypoint/init/security/network/mount/publicationのcanonical digest labelを照合し、`--build`または
image/config drift時は安全にdrainして再作成する。通常stopと失敗時のどちらもnamed volumeを保存する。

## grounded境界

実Apple Container 1.1.0/arm64で、標準OCI control/runner build、ACTIVE起動、exact publish/security inspect、
ACTIVE→DRAINING、同一drain replay、DRAININGからの復旧、ACTIVE→DRAINING→OFF、volume-backed MONITOR_ONLY再起動、
repeated stop、port conflictによるpartial-start compensation、control address不変drain、stale replay拒否、
crashed/expired attempt recoveryを実行した。machine-readable結果は
`evidence/ciso-06/apple-container-smoke.json`に固定した。
post-Round 2ではimmutable spec/`--build` reconciliation、non-expired active lease/attemptを保持したままの
stable-proxy drain、persisted deadline replay、trigger/direct INSERT fence、same-key concurrencyも追加でgroundした。
全検証lineageは`evidence/ciso-06/implementation-validation.json`に固定した。

fake/inert credentialと空queueを使ったためprovider/GitHub外部side effectは発生していない。`open`の実装は
loopback reachabilityを先に検査してexact Dashboard URLをmacOS `open`へ渡すが、headlessで代替できないheaded browser
lifecycleはこのserver/network境界の証明に不要なため起動していない。

## 残余リスク

- Apple Container smokeはarm64単一hostの最小実境界であり、CI/標準OCI testが通常Linux matrixを補完する。
- 実provider/GitHub credentialを使う長時間attemptのrehearsalは外部mutationを伴うため未実施。DB race test、
  SIGTERM drain、既存CISO-04 critical-boundary/expected-head suiteで安全境界を検証する。
- Apple Container custom network DNSの不安定性を観測したため、起動ごとにactual internal IPv4を解決する。container再作成で
  addressが変わった場合は`agentopsctl start`がcontrol/runnerを置換して設定を更新する。
