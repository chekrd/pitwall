---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, each question with your recommended answer. Then wait for the user's answers before the next round.

Post a round with the `mcp__pitwall__ask_questions` tool, one entry per question. The user answers each question on its own on the Pitwall dashboard, and can talk a single question through with a copy of this conversation before answering it. For each question give:

- `title`: a short name for the decision.
- `body`: the question, with what the user needs to answer it. It must stand on its own, as the user may read it without the others.
- `options`: when the question is a choice among a few concrete answers, those answers, each with a short label and a description if the label doesn't say it all. Leave them out for an open question.
- `recommendation`: your recommended answer and why. When it is one of the options, also give that option's label in `recommended`.

Put what applies to the whole round in `intro`: what the last answers settled, what a sub-agent found. After the call, say in one line that the round is posted, without repeating the questions, and end your turn.

The answers come back as one message, each named by its number. "Your recommendation" as an answer takes your recommendation as it stood. A question the user left unanswered is still on the frontier: ask it again in the next round, unless the other answers settled it.

If the tool is not available, write the round as text in this format instead, lettering a question's choices as `- (a) …`, `- (b) …`:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
