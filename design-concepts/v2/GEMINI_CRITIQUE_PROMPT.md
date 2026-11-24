# Prompt: Gemini design critique of Scevia v2

Attach `renders/01-overview.png`, `02-analytics.png`, `03-risk.png`, `04-scenario-lab.png`, plus `/DESIGN.md` and `/PRODUCT.md`.

---

You are a senior product designer reviewing four desktop screens of **Scevia**, a read-only portfolio intelligence app for prediction-market traders (Polymarket, Kalshi). PRODUCT.md and DESIGN.md are attached. The target quality bar is **getquin** and **Delta** (visual polish), plus **Portfolio Visualizer** (analytical organisation).

For each screen:
1. **Hierarchy:** can a first-time user find the answer to the page's question in under 10 seconds? What competes with it?
2. **Clutter:** name specific elements to remove, merge, or move lower down (be concrete: "remove the X chip on Y card").
3. **Trust:** any number that's ambiguous, missing a definition, or could be misread as a forecast?
4. **Consistency:** anything that breaks the shared system (spacing, card styles, colour meaning, button hierarchy)?
5. **vs. references:** where does it fall short of getquin/Delta polish, specifically?

Rules for your output:
- Don't suggest new colours or fonts. Work within DESIGN.md. If you think a token is wrong, say which token and why.
- Don't suggest probability or forecast features (product rule).
- Output a numbered list of **concrete changes**, each tagged `[screen] [severity: high/med/low]`, phrased so another AI agent can implement it without seeing the image (name the card, the element, and the exact change).
