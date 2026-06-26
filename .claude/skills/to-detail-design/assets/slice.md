<!--
  One slice = one PR = one issue. Copy this file to slices/SLICE-<SPEC>-NNN.md per slice.
  - Fill <…> and delete this comment.
  - Rich prose PLUS the one ```yaml core block below (the join-key surface the checks parse).
  - Seam / contract altitude only. Internal algorithms go in implementationNotes (not gated).
  - Reference system elements by id in dependsOnSystem; never copy their content here.
-->

# <SLICE-SPEC-NNN — short title>

**Narrative** — productGoal: <user-facing goal>; userStory: <as a … I want … so that …>.

**Component design (seam / contract only)**

- <which module exposes/consumes which contract or seam to satisfy the covered AC>

**Test approach** — <how acceptance.yaml's verification for the covered AC is met>

**Estimated scope** — <S / M / L>

```yaml
sliceId: SLICE-<SPEC>-NNN
coversAcIds: [AC-<SPEC>-NNN]
dependsOnSlices: []
dependsOnSystem: [DATA-NNN, ARCH-NNN]
```

<!-- optional, NOT gated — include only to pin an algorithm/optimisation:
implementationNotes: <the internal HOW you want fixed>
-->
