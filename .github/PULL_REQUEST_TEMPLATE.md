## What & why
<!-- What does this change and why? Link issues, e.g. "Closes #123". -->

## Checklist
- [ ] `npm test` passes (the per-file coverage gate is non-negotiable)
- [ ] Tests added/updated in the same change as the code
- [ ] `npm run build` succeeds (single-file `dist/sql.html`)
- [ ] Layers kept honest: pure logic in `src/core/`, network in `src/net/` (injected fetch), DOM in `src/ui/`
- [ ] No new runtime dependency (or it's a deliberate, justified addition — see CONTRIBUTING)
- [ ] README / `CHANGELOG.md` (`[Unreleased]`) updated if behavior or the deployed surface changed
- [ ] Reconciled affected tracked work (roadmap #68, the issue body, ADR/CHANGELOG) if this change reshaped it
