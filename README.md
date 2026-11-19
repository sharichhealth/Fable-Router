# fable-router

A Claude Code mod that routes work by cost, following the 10-80-10 idea: Fable plans, cheaper models do most of the work, Fable reviews. It only pays off on big jobs, so the mod also decides when delegating is not worth it.

What it does:

- Adds a routing policy to the system prompt: do small jobs directly, search with Haiku, and split only large jobs of many independent units.
- Registers three agent types: `fable-router:scout` (Haiku, low effort, read-only), `fable-router:worker` (Sonnet, medium) and `fable-router:architect` (Fable, high, read-only; PLAN or REVIEW).
- Runs the built-in Explore agent on Haiku at low effort instead of its default.
- When the main model is Fable, adds two rules: easy work of more than about 2 steps goes to the scout (searching, reading) or the worker (well-specified edits), and mid-level work that needs judgment goes to one Agent call on Opus.
- When the main session runs on Fable, built-in agents that would inherit it (general-purpose, Plan, claude) run on Opus unless a model is named; Fable work goes through the gated architect.
- Gates Fable: any Fable subagent must begin its brief with `SCALE: <n>`. Below the threshold (default 8) the call is refused, unless the brief also has a `JUDGMENT:` line for a single hard problem.
- Adds a cost note to the Agent tool's description.
- Shows 🟢 Fable Router beside the model name when on, 🔴 Fable Router when off. Use /fable-router for the counts and to switch.

Commands: `/fable-router stats`, `/fable-router on`, `/fable-router off`, `/fable-router threshold <n>`.
