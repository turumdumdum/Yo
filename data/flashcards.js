// Flashcards: term on the front, definition on the back.
window.FLASHCARDS = [
  // Agentic Architecture & Orchestration
  { domain: "agentic", front: "Agentic loop", back: "Call the model → if stop_reason is \"tool_use\", run the tools, append tool_result blocks, call again → stop when stop_reason is \"end_turn\" (plus a max-iteration safety cap)." },
  { domain: "agentic", front: "stop_reason: \"tool_use\" vs \"end_turn\"", back: "\"tool_use\": Claude wants tool results before continuing. \"end_turn\": Claude has finished its response. Other values: \"max_tokens\", \"stop_sequence\", \"pause_turn\", \"refusal\"." },
  { domain: "agentic", front: "Coordinator / subagent (hub-and-spoke)", back: "A coordinator decomposes the task, dispatches subagents with self-contained prompts, and synthesises their results. Subagents do NOT share the coordinator's history." },
  { domain: "agentic", front: "Context isolation of subagents", back: "Each subagent starts with a fresh context. Pass the goal, constraints and expected output explicitly; receive back a condensed result." },
  { domain: "agentic", front: "Workflow vs. agent", back: "Workflow: predefined code paths orchestrating LLM calls (predictable). Agent: the model dynamically decides its steps and tool use (flexible). Prefer the simplest that works." },
  { domain: "agentic", front: "Prompt chaining", back: "Decompose a task into fixed sequential steps, each an LLM call processing the previous output, with programmatic gates/checks between steps." },
  { domain: "agentic", front: "Parallelisation (fan-out/fan-in)", back: "Run independent subtasks concurrently (sectioning) or run the same task several times (voting), then aggregate." },
  { domain: "agentic", front: "Deterministic enforcement", back: "Critical business rules (limits, approvals, compliance) belong in code — hooks, tool validation, permissions — not only in the prompt." },
  { domain: "agentic", front: "Human-in-the-loop checkpoint", back: "A required human approval before high-impact or irreversible actions, enforced by the orchestration layer." },

  // Tool Design & MCP Integration
  { domain: "tools", front: "Tool description", back: "The main signal Claude uses to choose a tool. Explain purpose, when to use it (and when not), input formats, edge cases and example inputs." },
  { domain: "tools", front: "tool_choice: auto", back: "Default. Claude decides whether to call a tool or answer in text." },
  { domain: "tools", front: "tool_choice: any", back: "Claude must call one of the provided tools, but chooses which." },
  { domain: "tools", front: "tool_choice: {type: \"tool\", name}", back: "Forces Claude to call that specific tool — useful for guaranteed structured output." },
  { domain: "tools", front: "tool_choice: none", back: "Claude cannot call any tools in this request." },
  { domain: "tools", front: "is_error in tool_result", back: "Marks a tool result as an error. Include error category, whether it's retryable and useful context so Claude can recover." },
  { domain: "tools", front: "Error categories", back: "Transient (retry), validation (fix input), business rule (explain/escalate), permission (escalate). Distinguishing them drives correct recovery." },
  { domain: "tools", front: "MCP (Model Context Protocol)", back: "Open protocol connecting AI applications to external systems via servers exposing Tools, Resources and Prompts." },
  { domain: "tools", front: "MCP Resources", back: "Read-only data/content (files, records, docs) that a client can load into context — e.g. a catalogue so the agent knows what exists without exploratory calls." },
  { domain: "tools", front: ".mcp.json", back: "Project-scoped MCP server config at the repo root, shareable via git. Use ${ENV_VAR} expansion for secrets." },
  { domain: "tools", front: "Least-privilege tool scoping", back: "Give each agent only the tools it needs. Fewer, well-described tools improve selection accuracy and safety." },

  // Claude Code Configuration & Workflows
  { domain: "claudecode", front: "CLAUDE.md hierarchy", back: "~/.claude/CLAUDE.md (user, all projects) → ./CLAUDE.md (project, shared via git) → subdirectory CLAUDE.md (loaded when working there). CLAUDE.local.md is personal." },
  { domain: "claudecode", front: "@import in CLAUDE.md", back: "CLAUDE.md can import other files with @path/to/file to keep memory modular." },
  { domain: "claudecode", front: "settings.json scopes", back: "User: ~/.claude/settings.json. Project (shared): .claude/settings.json. Personal project overrides: .claude/settings.local.json." },
  { domain: "claudecode", front: "Permission rules", back: "allow / ask / deny lists in settings.json, e.g. \"Bash(npm test:*)\", \"Read(./src/**)\". Deny rules take precedence." },
  { domain: "claudecode", front: "Hooks", back: "Shell commands the harness runs at lifecycle events (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart…). Deterministic, unlike prompt instructions." },
  { domain: "claudecode", front: "PreToolUse hook", back: "Runs before a tool executes; can block the call (e.g. prevent edits to protected files) or modify behaviour." },
  { domain: "claudecode", front: "Custom slash commands / skills", back: "Markdown prompt files in .claude/commands or .claude/skills (project) or ~/.claude/ (user). Invoked by /name; skills can be auto-invoked by description." },
  { domain: "claudecode", front: "Skill progressive disclosure", back: "Only the skill's name + description are in context initially; SKILL.md and its bundled files load when the skill is used." },
  { domain: "claudecode", front: "Subagents in Claude Code", back: "Specialised agents (defined in .claude/agents/) with their own system prompt, tools and isolated context window." },
  { domain: "claudecode", front: "Plan mode", back: "Read-only exploration and planning mode; Claude proposes a plan for approval before editing anything. Great for large or ambiguous changes." },
  { domain: "claudecode", front: "Headless mode (claude -p)", back: "Non-interactive single-prompt run for scripts/CI. Supports --output-format json / stream-json and pre-configured allowed tools." },
  { domain: "claudecode", front: "/clear vs /compact", back: "/clear wipes the conversation context. /compact summarises it to free space while keeping the essentials." },

  // Prompt Engineering & Structured Output
  { domain: "prompt", front: "Explicit criteria", back: "Replace vague words (\"important\", \"good\") with concrete definitions of what to include/exclude — reduces false positives." },
  { domain: "prompt", front: "Few-shot prompting", back: "2–4 diverse input→output examples, including edge cases, wrapped in <example> tags. Most effective way to lock in format and judgement." },
  { domain: "prompt", front: "XML tags", back: "Structure prompts with tags like <instructions>, <document>, <examples> so Claude separates data from instructions." },
  { domain: "prompt", front: "Structured output via tool use", back: "Define a tool whose input_schema is your output schema and force it with tool_choice; Claude returns schema-shaped JSON." },
  { domain: "prompt", front: "Nullable / optional fields", back: "Let the model express 'not present' instead of fabricating values for required fields." },
  { domain: "prompt", front: "Validation-retry loop", back: "Validate output in code (sums, formats, cross-field rules); on failure send the specific error back and ask for a correction." },
  { domain: "prompt", front: "Message Batches API", back: "Asynchronous bulk processing at ~50% cost, results within 24h. For non-urgent workloads — not for blocking/real-time flows. Match results by custom_id." },
  { domain: "prompt", front: "Prefilling / system prompt role", back: "System prompt sets role, rules and context. Giving the reason behind rules helps Claude generalise correctly." },
  { domain: "prompt", front: "Chain of thought", back: "Asking Claude to reason step by step (or using extended thinking) improves accuracy on complex tasks; separate reasoning from the final answer with tags." },

  // Context Management & Reliability
  { domain: "context", front: "Prompt caching", back: "Cache a stable prompt prefix with cache_control. Static content first, variable content last. Reduces latency and cost for repeated prefixes." },
  { domain: "context", front: "Lost in the middle", back: "Info in the middle of long contexts may be under-used. Put key material at the start/end, use headers, and ask for relevant quotes first." },
  { domain: "context", front: "Case facts block", back: "A persistent, structured block of critical facts (IDs, amounts, dates) that survives summarisation verbatim." },
  { domain: "context", front: "Compaction / context editing", back: "Summarise or clear stale tool results and history to stay within the context window while keeping key findings." },
  { domain: "context", front: "Provenance", back: "Keep claim → source mapping through every step so outputs can be verified; mark conflicts and uncertainty explicitly." },
  { domain: "context", front: "Escalation triggers", back: "Good: explicit request for a human, policy gap, authorisation limit, legal/safety topic. Weak: self-reported confidence alone." },
  { domain: "context", front: "Error propagation", back: "Report partial results plus what failed, why and what was tried — never silently drop failures or fabricate data." },
  { domain: "context", front: "Stratified evaluation", back: "Measure accuracy per document type / segment, not just overall; aggregate metrics can hide failing categories." },
  { domain: "context", front: "Confidence calibration", back: "Check that stated confidence matches actual accuracy on labelled data before using it for routing decisions." },
];
