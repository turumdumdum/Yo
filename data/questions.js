// Practice question bank. `answer` is the index of the correct option (options are shuffled at runtime).
// These are original practice questions written in the style of the exam — not official exam items.
window.QUESTIONS = [
  // ───────────── Agentic Architecture & Orchestration ─────────────
  {
    id: "ag-01",
    domain: "agentic",
    question:
      "You are building an agent loop with the Messages API. After each response, how should your code decide whether to keep looping?",
    options: [
      "Check stop_reason: if it is \"tool_use\", execute the requested tools, append the results and call the API again; otherwise the turn is finished.",
      "Parse the assistant text for phrases like \"I'm done\" or \"task complete\".",
      "Always loop a fixed number of times (e.g. 10) to give the model enough chances.",
      "Stop as soon as the response contains any text block.",
    ],
    answer: 0,
    explanation:
      "stop_reason is the structured, reliable signal. \"tool_use\" means Claude is waiting for tool results; \"end_turn\" means it finished. Parsing natural language is brittle, and fixed iteration counts either cut work short or waste calls (a max-iteration cap is fine only as a safety net).",
  },
  {
    id: "ag-02",
    domain: "agentic",
    question:
      "A coordinator agent delegates research to three subagents. The subagents keep returning incomplete answers because they 'don't know' what the user originally asked. What is the best fix?",
    options: [
      "Give subagents access to the coordinator's full conversation history automatically.",
      "Have the coordinator pass the relevant context explicitly in each subagent's task prompt — goal, constraints, and what to return.",
      "Use a larger model for the subagents.",
      "Let subagents call the coordinator back with clarifying questions for every task.",
    ],
    answer: 1,
    explanation:
      "Subagents start with fresh, isolated context — they do not inherit the coordinator's history. The coordinator must write self-contained task prompts including goal, constraints, relevant findings and the expected output format.",
  },
  {
    id: "ag-03",
    domain: "agentic",
    question:
      "A refund agent must never issue a refund above $500 without human approval. Where should this rule be enforced for maximum reliability?",
    options: [
      "In the system prompt, in capital letters, repeated twice.",
      "In a few-shot example showing the agent refusing large refunds.",
      "Deterministically in code — e.g. a hook or the tool implementation that blocks/escalates refunds over $500.",
      "By asking the model to self-check its decision before calling the refund tool.",
    ],
    answer: 2,
    explanation:
      "Prompt instructions are probabilistic. Business rules with financial or safety impact should be enforced programmatically (pre-tool-use hooks, tool-side validation) so they hold 100% of the time; the prompt can still explain the rule.",
  },
  {
    id: "ag-04",
    domain: "agentic",
    question:
      "A task requires analysing 40 independent documents and then writing a combined report. Which orchestration pattern fits best?",
    options: [
      "A single agent reads all 40 documents sequentially in one context window.",
      "Fan-out: a coordinator dispatches subagents in parallel (each handles a subset and returns a concise summary), then synthesises the results.",
      "A chain of 40 agents where each passes its full context to the next.",
      "Ask the user to split the documents into 40 separate conversations.",
    ],
    answer: 1,
    explanation:
      "Independent subtasks parallelise well. Subagents keep each document's detail out of the coordinator's context and return condensed findings, which reduces context pressure and latency.",
  },
  {
    id: "ag-05",
    domain: "agentic",
    question:
      "When is a multi-agent architecture usually NOT worth its extra cost and complexity?",
    options: [
      "When the task is broad and can be split into independent parallel research tracks.",
      "When subtasks need very different tool sets.",
      "When the task is a tightly-coupled, sequential edit where every step depends on shared state (e.g. a small refactor of one file).",
      "When the combined material would overflow a single context window.",
    ],
    answer: 2,
    explanation:
      "Multi-agent systems use more tokens and add coordination overhead. They shine for parallelisable, breadth-first work; tightly-coupled tasks with lots of shared state are usually better handled by a single agent.",
  },
  {
    id: "ag-06",
    domain: "agentic",
    question:
      "Your agent occasionally gets stuck calling the same failing tool over and over. What is the most robust mitigation?",
    options: [
      "Add \"do not repeat yourself\" to the system prompt.",
      "Return structured errors that say whether the error is retryable, and enforce a max-iterations / max-retries guard in the orchestration code.",
      "Remove the tool entirely.",
      "Lower the temperature to 0.",
    ],
    answer: 1,
    explanation:
      "Informative errors let the model change strategy, and a hard iteration/retry cap in code guarantees the loop terminates even if the model misbehaves.",
  },
  {
    id: "ag-07",
    domain: "agentic",
    question:
      "A workflow always runs the same steps in the same order: extract fields → validate → store. What approach is most appropriate?",
    options: [
      "A fully autonomous agent that decides which step to run next.",
      "A fixed, code-driven workflow (prompt chaining) with a Claude call per step and programmatic checks between steps.",
      "A multi-agent debate between three models.",
      "A single prompt asking Claude to 'do everything'.",
    ],
    answer: 1,
    explanation:
      "When the path is known in advance, a deterministic workflow is cheaper, more predictable and easier to test than an autonomous agent. Use agents when the steps can't be predetermined.",
  },
  {
    id: "ag-08",
    domain: "agentic",
    question:
      "A coordinator receives results from parallel subagents. One subagent reports a claim that contradicts another. What should the coordinator do?",
    options: [
      "Silently keep whichever result arrived first.",
      "Average the two answers.",
      "Preserve both claims with their sources, flag the conflict, and either resolve it with further verification or surface it to the user.",
      "Discard both claims to be safe.",
    ],
    answer: 2,
    explanation:
      "Conflicting evidence is information. Keeping provenance and explicitly flagging disagreements (rather than hiding them) produces a trustworthy synthesis.",
  },
  {
    id: "ag-09",
    domain: "agentic",
    question:
      "In the Claude Agent SDK, how does a parent agent typically delegate work to a subagent?",
    options: [
      "By writing to a shared global variable that the subagent polls.",
      "Through a task/agent-spawning tool whose prompt describes the work; the subagent runs in its own context and returns a result.",
      "By copying its entire message history into a new API key.",
      "Subagents cannot be created from the SDK.",
    ],
    answer: 1,
    explanation:
      "The SDK exposes subagents via a tool (e.g. Task/Agent) that the parent calls with a prompt. The subagent runs with isolated context and its own allowed tools, then returns its final output to the parent.",
  },
  {
    id: "ag-10",
    domain: "agentic",
    question:
      "An agent will perform an irreversible action (deleting production data). What design is recommended?",
    options: [
      "Let the agent proceed if it is confident.",
      "Insert a human-in-the-loop approval checkpoint before the action, enforced by the orchestration layer or permission system.",
      "Ask the agent to wait 10 seconds before deleting.",
      "Log the action after it happens.",
    ],
    answer: 1,
    explanation:
      "High-impact, irreversible actions should require explicit human approval, enforced outside the model (permissions, hooks, approval steps).",
  },

  // ───────────── Tool Design & MCP Integration ─────────────
  {
    id: "tl-01",
    domain: "tools",
    question:
      "Claude keeps choosing `search_orders` when it should use `get_order_by_id`. Both tools have one-line descriptions. What is the most effective first fix?",
    options: [
      "Rename both tools to random names.",
      "Improve the tool descriptions: explain what each does, when to use it vs. the other, input formats and example inputs.",
      "Add a few-shot example to the user message.",
      "Force tool_choice to get_order_by_id for every request.",
    ],
    answer: 1,
    explanation:
      "Tool descriptions are the primary signal Claude uses for tool selection. Detailed descriptions with clear boundaries between similar tools are the highest-leverage fix.",
  },
  {
    id: "tl-02",
    domain: "tools",
    question:
      "You need Claude to ALWAYS return data through your `extract_invoice` tool (never plain text). Which setting guarantees this?",
    options: [
      "tool_choice: {\"type\": \"auto\"}",
      "tool_choice: {\"type\": \"tool\", \"name\": \"extract_invoice\"}",
      "tool_choice: {\"type\": \"none\"}",
      "Setting temperature to 0.",
    ],
    answer: 1,
    explanation:
      "Forcing a specific tool makes Claude call exactly that tool. \"any\" forces some tool, \"auto\" lets Claude decide, \"none\" prevents tool use.",
  },
  {
    id: "tl-03",
    domain: "tools",
    question:
      "A tool call fails because an external API timed out. What should the tool return to Claude?",
    options: [
      "An empty string.",
      "A tool_result with is_error: true and a clear message, e.g. category 'transient/timeout', whether retrying makes sense, and what was attempted.",
      "A fabricated plausible result so the agent can continue.",
      "Nothing — raise an exception and crash the loop.",
    ],
    answer: 1,
    explanation:
      "Structured, descriptive errors (is_error plus type, retryability, context) let Claude decide whether to retry, try another approach or escalate. Empty or fake results cause silent failures.",
  },
  {
    id: "tl-04",
    domain: "tools",
    question:
      "An agent has access to 25 tools and its tool selection accuracy is dropping. What is a recommended approach?",
    options: [
      "Add five more tools with overlapping functionality.",
      "Scope tools per agent/role: give each (sub)agent only the handful of tools relevant to its job.",
      "Merge all tools into one tool called `do_anything`.",
      "Remove all tool descriptions to save tokens.",
    ],
    answer: 1,
    explanation:
      "Too many tools increase confusion. Least-privilege tool scoping per agent improves accuracy and safety.",
  },
  {
    id: "tl-05",
    domain: "tools",
    question: "Which three primitives does an MCP server expose to clients?",
    options: [
      "Tools, Resources and Prompts",
      "Agents, Models and Tokens",
      "Hooks, Skills and Plugins",
      "Files, Folders and Databases",
    ],
    answer: 0,
    explanation:
      "MCP servers expose Tools (actions the model can invoke), Resources (data/content that can be read into context) and Prompts (reusable templates/workflows).",
  },
  {
    id: "tl-06",
    domain: "tools",
    question:
      "Your team wants a shared MCP server configuration committed to the repository so every developer using Claude Code gets it. Where should it go?",
    options: [
      "In each developer's ~/.claude.json only.",
      "In a project-scoped .mcp.json file at the repository root.",
      "Inside CLAUDE.md as a code block.",
      "In a .env file.",
    ],
    answer: 1,
    explanation:
      "Project-scoped MCP servers live in .mcp.json at the repo root and can be checked into version control. Secrets should be referenced via environment variables rather than hard-coded.",
  },
  {
    id: "tl-07",
    domain: "tools",
    question:
      "An MCP server needs an API token. What is the recommended way to provide it in a shared .mcp.json?",
    options: [
      "Hard-code the token in .mcp.json and commit it.",
      "Use environment variable expansion (e.g. ${API_TOKEN}) so each developer supplies their own secret.",
      "Paste the token into CLAUDE.md.",
      "Ask Claude to remember the token.",
    ],
    answer: 1,
    explanation:
      "Environment variable expansion keeps secrets out of version control while sharing the server configuration.",
  },
  {
    id: "tl-08",
    domain: "tools",
    question:
      "A tool returns a 5,000-line raw JSON payload, most of which is irrelevant. What is the best practice?",
    options: [
      "Return it all — more data is always better.",
      "Have the tool return a focused, relevant subset (filtered fields, pagination or a summary) to conserve context.",
      "Convert it to XML to make it smaller.",
      "Return a random sample of lines.",
    ],
    answer: 1,
    explanation:
      "Tool outputs consume context. Design tools to return high-signal, compact results (filtering, pagination, truncation with guidance) instead of dumping raw payloads.",
  },
  {
    id: "tl-09",
    domain: "tools",
    question:
      "A tool call fails because the user asked for a customer ID that does not exist. How should this be distinguished from a system failure?",
    options: [
      "It should not be distinguished — all errors are the same.",
      "Return a business/validation error (not retryable, e.g. 'customer not found') vs. a transient error (retryable), so the agent reacts appropriately.",
      "Retry the call five times anyway.",
      "Return HTTP 500 for everything.",
    ],
    answer: 1,
    explanation:
      "Categorising errors (validation, business rule, permission, transient) tells the agent whether to retry, ask the user, or escalate.",
  },
  {
    id: "tl-10",
    domain: "tools",
    question:
      "What does tool_choice: {\"type\": \"any\"} do?",
    options: [
      "Claude may answer in plain text or call a tool.",
      "Claude must call one of the provided tools, but it chooses which one.",
      "Claude must call every tool once.",
      "Tools are disabled.",
    ],
    answer: 1,
    explanation:
      "\"any\" forces a tool call while letting Claude pick the tool — useful when you require structured output but have several possible schemas.",
  },

  // ───────────── Claude Code Configuration & Workflows ─────────────
  {
    id: "cc-01",
    domain: "claudecode",
    question:
      "Team-wide coding conventions should apply to everyone working in a repository using Claude Code. Where should they be documented?",
    options: [
      "~/.claude/CLAUDE.md on each developer's machine.",
      "CLAUDE.md at the project root (committed to version control).",
      "In a Slack channel.",
      "In CLAUDE.local.md.",
    ],
    answer: 1,
    explanation:
      "Project-level CLAUDE.md is shared via git with the whole team. ~/.claude/CLAUDE.md is personal (all projects), and CLAUDE.local.md is personal and typically git-ignored.",
  },
  {
    id: "cc-02",
    domain: "claudecode",
    question:
      "A monorepo has a frontend/ and a backend/ folder with different conventions. How can Claude Code pick up folder-specific instructions?",
    options: [
      "Put all conventions into one giant root CLAUDE.md.",
      "Add CLAUDE.md files inside frontend/ and backend/; Claude Code loads them when working with files in those directories.",
      "Create two separate git repositories.",
      "Use environment variables.",
    ],
    answer: 1,
    explanation:
      "CLAUDE.md files are hierarchical: nested files in subdirectories are loaded when Claude works in those areas, keeping context relevant.",
  },
  {
    id: "cc-03",
    domain: "claudecode",
    question:
      "You want Claude Code to automatically run the formatter after every file edit, without relying on Claude remembering to do so. What should you use?",
    options: [
      "A reminder in CLAUDE.md.",
      "A PostToolUse hook configured in settings.json that runs the formatter after Edit/Write tools.",
      "A custom slash command.",
      "Plan mode.",
    ],
    answer: 1,
    explanation:
      "Hooks are executed deterministically by the harness at lifecycle events (PreToolUse, PostToolUse, etc.). Instructions in CLAUDE.md are only guidance.",
  },
  {
    id: "cc-04",
    domain: "claudecode",
    question:
      "You want to run Claude Code in a CI pipeline to review pull requests non-interactively. Which invocation fits?",
    options: [
      "Start `claude` and type the prompt by hand in the CI log.",
      "Use headless mode: `claude -p \"<prompt>\"` (optionally with --output-format json) and pre-configured allowed tools.",
      "Use plan mode only.",
      "It is not possible to run Claude Code in CI.",
    ],
    answer: 1,
    explanation:
      "The -p/--print flag runs a single non-interactive query, suitable for scripts and CI. Structured output formats make results machine-readable.",
  },
  {
    id: "cc-05",
    domain: "claudecode",
    question:
      "Before a large, risky refactor across many files, what Claude Code workflow is recommended?",
    options: [
      "Let Claude edit immediately and fix issues later.",
      "Use plan mode to explore the codebase and agree on a plan before any edits are made.",
      "Disable all tools.",
      "Run /clear repeatedly.",
    ],
    answer: 1,
    explanation:
      "Plan mode lets Claude read and analyse without modifying files, producing a plan you review before execution — ideal for complex or ambiguous changes.",
  },
  {
    id: "cc-06",
    domain: "claudecode",
    question:
      "Your team repeatedly types the same multi-step prompt to generate release notes. How can you make this a reusable, shared command?",
    options: [
      "Save it in a personal notes app.",
      "Create a custom slash command / skill as a Markdown file in the project's .claude/ directory and commit it.",
      "Add it to .gitignore.",
      "Put it in an environment variable.",
    ],
    answer: 1,
    explanation:
      "Project commands/skills stored in .claude/ (e.g. .claude/commands or .claude/skills) are version-controlled and available to everyone on the team.",
  },
  {
    id: "cc-07",
    domain: "claudecode",
    question:
      "What is the main benefit of delegating a broad codebase search to a subagent in Claude Code?",
    options: [
      "Subagents are always faster models.",
      "The search's verbose exploration happens in the subagent's separate context; only a concise result returns, keeping the main context clean.",
      "Subagents can bypass permissions.",
      "Subagents have unlimited context windows.",
    ],
    answer: 1,
    explanation:
      "Context isolation is the key benefit: exploratory noise stays in the subagent, and the main conversation receives just the conclusions.",
  },
  {
    id: "cc-08",
    domain: "claudecode",
    question:
      "How do you pre-approve safe commands like `npm test` so Claude Code doesn't prompt for permission each time, for the whole team?",
    options: [
      "Add a permissions allow rule (e.g. \"Bash(npm test:*)\") to the project's .claude/settings.json.",
      "Tell Claude in chat to stop asking.",
      "Run Claude Code as root.",
      "Put the command in README.md.",
    ],
    answer: 0,
    explanation:
      "Permission rules in settings.json (allow/deny/ask) control tool access. Project settings are shared; .claude/settings.local.json is for personal overrides.",
  },
  {
    id: "cc-09",
    domain: "claudecode",
    question:
      "A skill should be loaded only when relevant rather than consuming context in every session. What makes this possible?",
    options: [
      "Skills are always fully loaded at startup.",
      "Skills use progressive disclosure: only the name/description is loaded up front; the full SKILL.md and resources load when the skill is invoked.",
      "Skills must be pasted into CLAUDE.md.",
      "Skills only work in the API, not in Claude Code.",
    ],
    answer: 1,
    explanation:
      "Progressive disclosure keeps the base context lean: the description is used to decide when to load the skill's full instructions.",
  },
  {
    id: "cc-10",
    domain: "claudecode",
    question:
      "A long Claude Code session has drifted and the context is full of stale exploration. What is a good way to continue on a new, unrelated task?",
    options: [
      "Keep going in the same session.",
      "Use /clear (or start a new session) so the new task starts with a clean context; use /compact if you need to keep a summary of the current work.",
      "Restart your computer.",
      "Delete CLAUDE.md.",
    ],
    answer: 1,
    explanation:
      "/clear resets the conversation; /compact summarises it to free space while keeping key context. Fresh context improves focus and quality.",
  },

  // ───────────── Prompt Engineering & Structured Output ─────────────
  {
    id: "pe-01",
    domain: "prompt",
    question:
      "A code-review prompt says \"flag only important issues\" and Claude flags many trivial nits. What is the best fix?",
    options: [
      "Add \"be very careful\" to the prompt.",
      "Define explicit criteria for what counts as reportable (e.g. correctness bugs, security issues) and what to skip (style, naming), ideally with examples.",
      "Increase max_tokens.",
      "Ask for fewer words in the output.",
    ],
    answer: 1,
    explanation:
      "Vague instructions like \"important\" leave judgment to the model. Concrete inclusion/exclusion criteria and examples produce consistent, precise behaviour.",
  },
  {
    id: "pe-02",
    domain: "prompt",
    question:
      "You need 100% syntactically valid JSON matching a schema from an extraction task. What is the most reliable approach?",
    options: [
      "Ask nicely for JSON in the prompt.",
      "Define a tool with an input_schema for the output and force Claude to call it (or use structured outputs), then validate the result in code.",
      "Use a regex to fix broken JSON afterwards.",
      "Ask for YAML instead.",
    ],
    answer: 1,
    explanation:
      "Tool use with a JSON schema (forced via tool_choice) or structured outputs gives schema-shaped output. Code-side validation still catches semantic errors.",
  },
  {
    id: "pe-03",
    domain: "prompt",
    question:
      "Structured output always parses correctly, but sometimes line-item totals don't add up to the invoice total. How should this be handled?",
    options: [
      "Nothing — the schema guarantees correctness.",
      "Add semantic validation in code; on failure, send the specific error back to Claude and ask it to correct the extraction (validation-retry loop).",
      "Switch to free-text output.",
      "Remove the total field from the schema.",
    ],
    answer: 1,
    explanation:
      "Schemas guarantee structure, not semantic correctness. A validation-and-retry loop with specific error feedback fixes these cases.",
  },
  {
    id: "pe-04",
    domain: "prompt",
    question:
      "A document may genuinely lack a 'due_date'. Claude sometimes invents one to fill the required field. What schema change helps most?",
    options: [
      "Keep it required and add \"do not hallucinate\".",
      "Make the field nullable/optional (and describe when to use null) so Claude has a legitimate way to express 'not present'.",
      "Rename the field.",
      "Set the default to today's date.",
    ],
    answer: 1,
    explanation:
      "Required fields pressure the model to fabricate. Nullable/optional fields (and an 'unknown/other' enum value where relevant) let it report absence honestly.",
  },
  {
    id: "pe-05",
    domain: "prompt",
    question:
      "Output formatting is inconsistent across runs even with clear instructions. What technique usually helps the most?",
    options: [
      "Provide 2–4 diverse few-shot examples showing the exact desired input→output format, including edge cases.",
      "Increase temperature.",
      "Remove the system prompt.",
      "Write the instructions in all caps.",
    ],
    answer: 0,
    explanation:
      "Few-shot examples are one of the most effective ways to lock in format and handle ambiguous cases; varied examples prevent overfitting to one pattern.",
  },
  {
    id: "pe-06",
    domain: "prompt",
    question:
      "A prompt mixes instructions, a long contract, and examples, and Claude sometimes confuses them. What is recommended?",
    options: [
      "Put everything on one line.",
      "Separate the parts with clear XML tags (e.g. <instructions>, <contract>, <examples>) and refer to them by name.",
      "Translate the contract into another language.",
      "Delete the examples.",
    ],
    answer: 1,
    explanation:
      "XML tags give unambiguous structure, making it easy for Claude to tell data from instructions and for you to reference sections.",
  },
  {
    id: "pe-07",
    domain: "prompt",
    question:
      "You must classify 200,000 support tickets overnight; results are not needed in real time. What is the most cost-effective API option?",
    options: [
      "Send 200,000 synchronous requests as fast as possible.",
      "Use the Message Batches API, which processes requests asynchronously at a significant discount (results within up to 24h).",
      "Use streaming.",
      "Use the largest model with extended thinking for each ticket.",
    ],
    answer: 1,
    explanation:
      "The Batches API is designed for large, non-latency-sensitive workloads and is cheaper than standard calls. It is not suitable for blocking, real-time flows.",
  },
  {
    id: "pe-08",
    domain: "prompt",
    question:
      "When is the Message Batches API a poor choice?",
    options: [
      "Nightly bulk evaluation of a prompt against a test set.",
      "A pre-merge CI check that a developer is actively waiting on.",
      "Backfilling summaries for an archive of documents.",
      "Weekly report generation.",
    ],
    answer: 1,
    explanation:
      "Batches can take up to 24 hours and have no latency guarantee, so they don't suit blocking, interactive workflows.",
  },
  {
    id: "pe-09",
    domain: "prompt",
    question:
      "Why is giving Claude the reason behind an instruction (e.g. \"Never use ellipses because this output is read by a text-to-speech engine\") useful?",
    options: [
      "It has no effect.",
      "Context about the goal helps Claude generalise the rule correctly to cases the instruction didn't explicitly cover.",
      "It makes responses longer, which is always better.",
      "It disables safety filters.",
    ],
    answer: 1,
    explanation:
      "Explaining motivation lets Claude understand the underlying goal and apply it sensibly, rather than following the literal rule only.",
  },
  {
    id: "pe-10",
    domain: "prompt",
    question:
      "An extraction must classify a document type, but some documents don't match any predefined category. How should the enum be designed?",
    options: [
      "List only the known categories so Claude is forced to choose one.",
      "Include an \"other\" (plus optional free-text detail field) so unexpected documents aren't forced into a wrong category.",
      "Use a free-text field with no enum at all.",
      "Use numeric codes instead of names.",
    ],
    answer: 1,
    explanation:
      "An escape-hatch value like \"other\"/\"unclear\" prevents misclassification when inputs fall outside the expected set, while keeping the output structured.",
  },

  // ───────────── Context Management & Reliability ─────────────
  {
    id: "cx-01",
    domain: "context",
    question:
      "Many requests share the same long system prompt and reference document. How can you reduce latency and cost?",
    options: [
      "Shorten the document by deleting random paragraphs.",
      "Use prompt caching: place the stable content at the beginning of the prompt and mark it with cache_control.",
      "Send the document in a separate request first.",
      "Use a higher temperature.",
    ],
    answer: 1,
    explanation:
      "Prompt caching reuses the processed prefix across requests. Put static content first and variable content (the user question) after the cache breakpoint.",
  },
  {
    id: "cx-02",
    domain: "context",
    question:
      "In a long customer-support conversation, the agent forgets exact order numbers and amounts mentioned early on after the history is summarised. What is the best fix?",
    options: [
      "Summarise more aggressively.",
      "Keep critical facts (IDs, amounts, dates, commitments) in a persistent structured 'case facts' block that is always included verbatim, and summarise only the rest.",
      "Ask the customer to repeat everything.",
      "Disable summarisation and let the context overflow.",
    ],
    answer: 1,
    explanation:
      "Progressive summarisation loses precise details. Extract important facts into a structured block that persists unchanged across turns.",
  },
  {
    id: "cx-03",
    domain: "context",
    question:
      "Research shows models can under-use information placed in the middle of a very long context. How can you mitigate this 'lost in the middle' effect?",
    options: [
      "Put the most important instructions only in the middle.",
      "Put key content and instructions at the beginning or end, use clear section headers, and ask the model to quote relevant passages before answering.",
      "Remove all headings.",
      "Duplicate the entire document three times.",
    ],
    answer: 1,
    explanation:
      "Positioning, clear structure and asking Claude to first extract relevant quotes all improve recall over long documents.",
  },
  {
    id: "cx-04",
    domain: "context",
    question:
      "A support agent receives a request it is not authorised to handle (a legal threat). What should it do?",
    options: [
      "Try its best to resolve it anyway.",
      "Escalate to a human following a defined policy, passing along a concise structured summary of the case.",
      "Ignore the message.",
      "Close the ticket.",
    ],
    answer: 1,
    explanation:
      "Clear escalation criteria (policy gaps, legal/safety topics, explicit customer request for a human) plus a good hand-off summary make agents reliable.",
  },
  {
    id: "cx-05",
    domain: "context",
    question:
      "Which is a poor trigger for escalating to a human?",
    options: [
      "The customer explicitly asks for a human.",
      "The request falls outside documented policy.",
      "The model's self-reported confidence score is below some threshold, used as the only signal.",
      "The action exceeds the agent's authorisation limits.",
    ],
    answer: 2,
    explanation:
      "Self-reported confidence is often poorly calibrated. Prefer objective triggers (explicit requests, policy gaps, authorisation limits) and calibrate any confidence signal against labelled data.",
  },
  {
    id: "cx-06",
    domain: "context",
    question:
      "A research agent synthesises facts from many sources. Stakeholders need to verify claims. What should the final output include?",
    options: [
      "Only the conclusions, to keep it short.",
      "Claims linked to their sources (provenance/citations), with conflicts and uncertainties clearly marked.",
      "A disclaimer that AI may be wrong.",
      "The full text of every source.",
    ],
    answer: 1,
    explanation:
      "Preserving claim→source mapping through the pipeline enables verification and trust; subagents should return sources along with findings.",
  },
  {
    id: "cx-07",
    domain: "context",
    question:
      "A subagent fails to retrieve one of five sources. How should this be reported back to the coordinator?",
    options: [
      "Silently return the four successful results as if they were complete.",
      "Return the partial results plus an explicit note of what failed, why, and what was attempted, so the coordinator can decide to retry or proceed.",
      "Return an error and discard the four results.",
      "Invent the missing source's content.",
    ],
    answer: 1,
    explanation:
      "Errors should propagate with context. Silent partial success hides gaps; discarding good work is wasteful. Explicit partial results allow informed decisions.",
  },
  {
    id: "cx-08",
    domain: "context",
    question:
      "To check a new prompt's reliability before shipping, what is the best practice?",
    options: [
      "Try it once manually and ship if it looks good.",
      "Build an evaluation set of representative and edge-case inputs with expected outcomes, and measure accuracy (overall and per category) before and after changes.",
      "Ask Claude if the prompt is good.",
      "Only test the happy path.",
    ],
    answer: 1,
    explanation:
      "Systematic evals with representative data and per-segment metrics reveal regressions and weak spots that spot checks miss.",
  },
  {
    id: "cx-09",
    domain: "context",
    question:
      "A pipeline reports 97% overall extraction accuracy, but one document type has 60% accuracy. Why does this matter?",
    options: [
      "It doesn't — the aggregate is what counts.",
      "Aggregate metrics can hide failing segments; measure per category and route low-accuracy segments to human review or targeted fixes.",
      "It means the evaluation set is wrong.",
      "It means the model is overfitting.",
    ],
    answer: 1,
    explanation:
      "Stratified metrics reveal where the system is unreliable. Automation decisions (e.g. skipping human review) should be based on segment-level accuracy.",
  },
  {
    id: "cx-10",
    domain: "context",
    question:
      "Tool results from earlier steps are filling the context window during a long agent run. What is an effective strategy?",
    options: [
      "Increase max_tokens.",
      "Trim or clear old, no-longer-needed tool results (or store them externally and keep short references/summaries), keeping key findings in context.",
      "Restart the agent from scratch every 3 steps.",
      "Ask the model to ignore old tool results.",
    ],
    answer: 1,
    explanation:
      "Context editing / compaction strategies remove stale bulky content while persisting important facts (e.g. in notes or memory files) so the agent can continue efficiently.",
  },
];
