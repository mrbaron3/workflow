# deploy — 標準 OCI アプリケーションイメージと runtime smoke

CISO-01（Issue #11・親 #10）が確立する **標準 OCI ランタイム基盤** の配布物一式。Apple Container 固有形式を使わず、
`container` / `docker` / `podman` のいずれでも同一に build・run できる（AC-CISO-011）。

## Containerfile

`deploy/Containerfile` は multi-stage の標準 OCI ビルド（`deps → build → runtime`）。

```sh
# build 文脈はリポジトリ root
container build -t agentops-app:dev -f deploy/Containerfile .   # Apple Container
docker    build -t agentops-app:dev -f deploy/Containerfile .   # 可搬性（標準 OCI）確認
```

- 全 path はコンテナ絶対（`WORKDIR /app`）。macOS の `/Users/...` を一切参照しない
  （`src/runtime/paths.ts` の scanner が build/runtime surface を静的検査して保証する）。
- `runtime` stage は非 root（`node` uid 1000）で動く。
- `build` stage で `npm run typecheck` を通し、「build/typecheck grader がコンテナ内・コンテナ相対 path で走る」ことを
  ビルド時に接地する。
- Go 製 agentops-control（#13/#16）は将来 `control-build` stage を追加して差し込む seam を Containerfile 冒頭に明記済み。
  この TypeScript runner イメージには手を入れない。

## runtime adapter 境界

`src/runtime/` が OS 非依存の core。Apple Container / macOS 固有処理は `apple-container.ts` だけに閉じ、
`oci-cli.ts`（docker/podman 互換）は同じ port を実装して境界が本当に runtime 中立であることを接地する。
preflight・publish invariant・container-neutral path は runtime 実装に依存しない。詳細は
[`docs/_system/container-runtime/`](../docs/_system/container-runtime/architecture.md) と
[`docs/decisions/ADR-0011-*`](../docs/decisions/) を参照。

## grounded smoke

`scripts/runtime-smoke.ts` は実エンジンで topology を一気通貫に立ち上げ、全 AC を接地する。捏造 pass をせず、
preflight 不成立や検査不成立では非 0 で終了し、JSON 証跡を出力する。

```sh
npx tsx scripts/runtime-smoke.ts                  # Apple Container（既定・#11 の必須接地）
npx tsx scripts/runtime-smoke.ts --runtime=docker # 標準 OCI 可搬性の補助証跡
npx tsx scripts/runtime-smoke.ts --keep           # 調査用に topology を残す
```

検査項目: preflight（fail-closed）→ 標準 OCI build → publish invariant（静的）→ 内部 network＋永続 volume →
postgres 公式 image（内部・volume）／control（loopback publish）／runner（内部）起動 → host publish surface 接地
（control は到達可・5432 と control container port は Mac で拒否）→ コンテナ内 `npm run typecheck`（`/app` 相対・
Mac 絶対 path 非依存）→ drain/stop。

## PostgreSQL control store（CISO-02）

明示的なschema migration:

```sh
AGENTOPS_DATABASE_URL='postgresql://…' npm run control-store:migrate
```

通常consumer/runner起動はDDLを変更せずexact version/checksumをverifyしてfail closedにする。Apple Container実機で
transaction/競合/lease/reclaim/LISTEN+reconciliationとpersistent-volume recoveryを再現するには:

```sh
npm run smoke:postgres:apple
```

Apple Containerのext4 named volumeには`lost+found`があるため、volumeは`/var/lib/postgresql`へmountし、
`PGDATA=/var/lib/postgresql/data`を指定する。PostgreSQLとrunnerにhost publishはない。
