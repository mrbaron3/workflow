# Architecture（移設済み）

> この単一アーキテクチャ文書は、理想ツリー（[DOC_TAXONOMY](_meta/DOC_TAXONOMY.md)）に従って分解されました。
> 「何であるか」は system 層・境界の関係、「なぜそう決めたか」は ADR が持ちます。

| 探しているもの | 住処 |
| --- | --- |
| 境界コンテキストの関係（C4 macro・旧 Layers） | [context-map.md](context-map.md) |
| 中核ループの構造・Data flow・拡張 seam | [`_system/evaluation/architecture.md`](specs/_system/evaluation/architecture.md) |
| 各境界の構造（planning 等） | [`_system/<ctx>/architecture.md`](specs/_system/planning/architecture.md) |
| 設計判断（zod 契約・hard gates・決定論・Why JSON） | [decisions/（ADR）](decisions/README.md) |
