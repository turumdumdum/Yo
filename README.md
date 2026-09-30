# CCA Prep — Claude Certified Architect exam trainer

A small, dependency-free web app for preparing for the **Claude Certified Architect – Foundations** exam.

## Features

- **Practice by domain** — questions with instant feedback and explanations, per domain or all at once.
- **Review mistakes** — re-practice only the questions you last got wrong.
- **Mock exam** — timed, questions drawn proportionally to domain weights, scaled score (100–1000, pass at 720), per-domain breakdown and answer review.
- **Flashcards** — key terms per domain, flip cards, "I know this" tracking (keyboard: Space = flip, → = know, ← = back).
- **Progress** — accuracy per domain, exam history, flashcard progress. Stored locally in your browser (`localStorage`).

## Exam domains

| Domain | Weight |
| --- | --- |
| Agentic Architecture & Orchestration | 27% |
| Claude Code Configuration & Workflows | 20% |
| Prompt Engineering & Structured Output | 20% |
| Tool Design & MCP Integration | 18% |
| Context Management & Reliability | 15% |

## Run locally

No build step — just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Publish with GitHub Pages

Repository **Settings → Pages → Build and deployment → Deploy from a branch**, choose the branch and `/ (root)`.

## Adding content

- Questions: `data/questions.js` — `{ id, domain, question, options[], answer (index), explanation }`
- Flashcards: `data/flashcards.js` — `{ domain, front, back }`
- Domains & weights: `data/domains.js`

## Disclaimer

Unofficial study aid, not affiliated with Anthropic. Questions are original practice items, not real exam questions. Always check the official exam guide for the current domains, weights and format.
