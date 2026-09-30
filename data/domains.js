// Exam domains and their approximate weights in the Claude Certified Architect – Foundations exam.
// Weights are used to build a proportionally balanced mock exam.
window.DOMAINS = [
  {
    id: "agentic",
    name: "Agentic Architecture & Orchestration",
    short: "Agentic Architecture",
    weight: 27,
    description:
      "Agent loops, stop conditions, multi-agent coordinator/subagent patterns, task decomposition, hooks and human-in-the-loop checkpoints.",
  },
  {
    id: "tools",
    name: "Tool Design & MCP Integration",
    short: "Tools & MCP",
    weight: 18,
    description:
      "Writing clear tool descriptions, tool_choice, structured error responses, MCP servers/resources/prompts and scoping tool access.",
  },
  {
    id: "claudecode",
    name: "Claude Code Configuration & Workflows",
    short: "Claude Code",
    weight: 20,
    description:
      "CLAUDE.md hierarchy, settings and permissions, slash commands, skills, subagents, plan mode, hooks and CI/headless usage.",
  },
  {
    id: "prompt",
    name: "Prompt Engineering & Structured Output",
    short: "Prompting & Output",
    weight: 20,
    description:
      "Explicit criteria, few-shot examples, XML structuring, JSON schemas via tool use, validation/retry loops and batch processing.",
  },
  {
    id: "context",
    name: "Context Management & Reliability",
    short: "Context & Reliability",
    weight: 15,
    description:
      "Context window budgeting, prompt caching, summarization, provenance, escalation, error propagation and confidence calibration.",
  },
];
