# Demo: hallucinated package (slopsquat)

Ask an agent for something niche, e.g. "add a codemod that migrates our React class components".
Models sometimes reach for `react-codeshift` — a conflation of `jscodeshift` and `react-codemod`
that someone has since registered on npm.

```bash
ladon check react-codeshift -v
# ■ HOLD npm:react-codeshift@1.0.0 risk 75/100
#   • AI models hallucinate this name (Hallucination Atlas)
#   • name blends "react-is" and "jscodeshift" — a typical AI-hallucinated shape
#   • only 11 downloads last week
ladon check express-jwt-session-guard
# ■ HOLD … does not exist on npm — the agent likely hallucinated this name
```
