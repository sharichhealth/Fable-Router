import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// fable-router: a cost-aware dispatcher for Claude Code.
//
// 10-80-10: Fable plans (10%), cheap models do the work (80%), Fable reviews (10%).
// It only pays off on big jobs, because planning, writing briefs and reviewing
// cost the same whether the job is big or small. So the mod:
//   1. tells the main model the routing policy (prompt.compose)
//   2. offers three agent types: scout (Haiku), worker (Sonnet), architect (Fable)
//   3. guards the Agent tool: Explore runs on Haiku, and any Fable subagent must
//      declare `SCALE: <n>` in its brief; below the threshold the call is refused
//      with "do it yourself" (the auto-mode "is it worth it?" decision)
//   4. /fable-router on | off | threshold <n> | stats

type Mode = 'on' | 'off'

const DEFAULT_THRESHOLD = 8
const FABLE_TYPES = new Set(['fable-router:architect'])
const SCALE_RE = /^\s*SCALE\s*:\s*(\d+)/im

// Bumped on every change so the chip beside the model redraws.
const tick = atom({ plugin: 'fable-router', key: 'tick' } as const, 0)

// Counters for this load (a reload starts them over).
const stats = { haikuScouts: 0, workers: 0, opusDefaults: 0, fableAllowed: 0, fableRefused: 0 }

// Built-in agent types that run on the main model when no model is given.
// Agents with their own model (yours, or this mod's) are left alone.
const INHERITING_TYPES = new Set(['general-purpose', 'Plan', 'claude'])

const SCOUT_PROMPT = `You are a fast, cheap read-only scout. Find files, symbols, config values and
facts the caller asked for. Read excerpts, not whole files. Answer with paths
(path:line) and a short conclusion. Never edit anything. If the question needs
judgment or design, say so in one line instead of guessing.`

const WORKER_PROMPT = `You are a worker executing a brief written by a planner. Follow the brief
exactly; it is your only context. Do the work, verify it (run the check the brief
names, or the obvious one), and report: what you changed, what you verified, what
you could not do. Do not widen scope. If the brief is ambiguous, pick the most
conservative reading and say which one you picked.`

const ARCHITECT_PROMPT = `You are the architect: the expensive model, used only where judgment pays.
You are called for one of two jobs, named at the top of the brief:
- PLAN: split a large job into independent work units. For each unit give a
  self-contained brief (goal, files, done-when, how to verify) a cheaper model can
  run without asking questions. Say which units can run in parallel. Keep the plan
  short: your tokens are the costly ones.
- REVIEW: check finished work against the goal. Report only real defects with
  file:line and why; say plainly when it is fine. Do not rewrite the work.`

const FABLE_MAIN = `

Main model is Fable, the costliest tier, so hand off more than usual:
- Easy work that can be handed off and needs more than about 2 tool calls: searching or reading goes to \`fable-router:scout\` (Haiku); well-specified edits or writing go to \`fable-router:worker\` (Sonnet). Tasks of 1-2 steps stay in this thread, since handing them off costs more than it saves.
- Mid-level work that needs judgment but not Fable (an unclear spec to interpret, moderate debugging, a careful rewrite): one Agent call with \`model: "opus"\`. Keep only the hardest reasoning in this thread.`

const policy = (threshold: number, fableMain = false) => `# Cost routing (fable-router mod)
Pick the cheapest setup that does the job well. Delegation has a fixed cost (plan + brief + review) paid on every job. Anthropic measured multi-agent runs at about 15x the tokens of a chat, and found an orchestrator with cheaper subagents wins mainly on routine, long-tail work or work larger than one context window; for a single dependent chain the strong model alone does better.

Decide before delegating:
- Small or single-thread job (a few files, one fix, one answer): do it yourself. No subagents.
- Searching or locating across many files: use \`fable-router:scout\` (Haiku). The built-in Explore agent is also forced onto Haiku by this mod.
- Many independent, well-specified units (roughly ${threshold}+ files, documents, clips, records): 10-80-10. Optionally ask \`fable-router:architect\` to PLAN, run the units on \`fable-router:worker\` (Sonnet) in parallel, then ask \`fable-router:architect\` to REVIEW.
- Hard reasoning that does not split (tricky design, subtle bug, decision with trade-offs): one \`fable-router:architect\` call, or the main thread itself. Do not split it.

Gate: every Agent call that runs on Fable (model "fable" or \`fable-router:architect\`) must start its brief with a line \`SCALE: <n>\` where n is the number of independent units the job covers. Below ${threshold} the call is refused; then do the work yourself or with a worker. Set \`SCALE: 0\` honestly for a single hard problem and add a line \`JUDGMENT: <why it needs Fable>\`; that is allowed.
Never pass \`effort\` to make a cheap agent think harder; the agent types already carry their own effort.${fableMain ? FABLE_MAIN : ''}`

async function getMode($: EngineInterface): Promise<Mode> {
  return ((await $.store.get('mode')) as Mode | undefined) ?? 'on'
}

async function getThreshold($: EngineInterface): Promise<number> {
  return Number((await $.store.get('threshold')) ?? DEFAULT_THRESHOLD)
}

function statsLine(): string {
  return `haiku ${stats.haikuScouts} · sonnet ${stats.workers} · opus ${stats.opusDefaults} · fable ${stats.fableAllowed} · refused ${stats.fableRefused}`
}

// Redraws the Auto/Off chip; the mode argument is kept for call sites.
function footerLine(): string {
  return `H${stats.haikuScouts} S${stats.workers} O${stats.opusDefaults} F${stats.fableAllowed}`
}

function showStatus($: EngineInterface, _mode: Mode) {
  $.ui.status(undefined) // clears the old text line of 0.1.x
  void update($, tick, n => n + 1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void $.ui.close({ id: 'fable-router' }).catch(() => {}) // the 0.3.0 side panel
    await $.command.register({
      name: 'fable-router',
      description: 'Cost router: on | off | threshold <n> | stats',
    })
    await $.agent.register({
      name: 'scout',
      description:
        'Cheap read-only search on Haiku: locate files, symbols, config, facts across many files. Use instead of Explore.',
      prompt: SCOUT_PROMPT,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
      model: 'haiku',
      effort: 'low',
    })
    await $.agent.register({
      name: 'worker',
      description:
        'Sonnet worker for one well-specified unit of a larger job (the 80% in 10-80-10). Give it a self-contained brief.',
      prompt: WORKER_PROMPT,
      model: 'sonnet',
      effort: 'medium',
    })
    await $.agent.register({
      name: 'architect',
      description:
        'Fable, for PLAN or REVIEW of big jobs, or one hard judgment call. Brief must start with "SCALE: <n>" (and PLAN or REVIEW).',
      prompt: ARCHITECT_PROMPT,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
      model: 'fable',
      effort: 'high',
    })
    showStatus($, await getMode($))
    return next(e)
  })

  // Re-pin the status line on every message, so it comes back after a reload.
  on('prompt.submit', async ($, e, next) => {
    try {
      showStatus($, await getMode($))
    } catch {
      // never block a message over a status line
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await getMode($)) === 'off') return composed
    return {
      sections: [
        ...composed.sections,
        { id: 'fable-router:policy', text: policy(await getThreshold($), /fable/i.test(String((e as any).promptModel ?? ''))), scope: 'session' as const },
      ],
    }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const mode = await getMode($)
    if (mode === 'off' || e.subagent_type === 'fork') return next(e)
    const threshold = await getThreshold($)
    const type = e.subagent_type ?? 'general-purpose'

    // Explore runs on the `opus` alias by default (Anthropic sub-agents docs);
    // run it on Haiku instead. A subagent on a different model does not take the
    // session's effort, so set it too.
    if (type === 'Explore' && e.model === undefined) {
      stats.haikuScouts++
      showStatus($, mode)
      return next({ ...e, model: 'haiku', effort: e.effort ?? 'low' })
    }
    if (type === 'fable-router:scout') stats.haikuScouts++

    // Main loop on Fable: a built-in agent with no model would inherit Fable
    // and slip past the gate. Run it on Opus instead; Fable work goes through
    // fable-router:architect, which the gate checks.
    if (e.model === undefined && INHERITING_TYPES.has(type)) {
      const main = await $.session.model().catch(() => '')
      if (/fable/i.test(main)) {
        stats.opusDefaults++
        showStatus($, mode)
        return next({ ...e, model: 'opus' })
      }
    }

    const isFable = e.model === 'fable' || (FABLE_TYPES.has(type) && e.model === undefined)
    if (isFable) {
      const m = SCALE_RE.exec(e.prompt)
      const scale = m ? Number(m[1]) : undefined
      const hasJudgment = /^\s*JUDGMENT\s*:\s*\S/im.test(e.prompt)
      let reason: string | undefined
      if (scale === undefined)
        reason = `a Fable subagent needs a first line "SCALE: <n>" (independent units this job covers). Add it, or do the work without Fable.`
      else if (scale < threshold && !hasJudgment)
        reason = `SCALE ${scale} is under the threshold ${threshold}: planning, briefing and reviewing would cost more than they save. Do it yourself, or use fable-router:worker. (For one hard problem that needs Fable, add "JUDGMENT: <why>".)`
      if (reason) {
        stats.fableRefused++
        showStatus($, mode)
        return { deny: `fable-router: ${reason}` }
      }
      stats.fableAllowed++
    } else if (type === 'fable-router:worker' || e.model === 'sonnet') {
      stats.workers++
    } else if (e.model === 'haiku' && type !== 'fable-router:scout') {
      stats.haikuScouts++
    } else if (e.model === 'opus') {
      stats.opusDefaults++
    }
    showStatus($, mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  // The guard fails open: a bug in the router never blocks your work.

  // Anthropic's Fable 5.2 prompting guide: stating in the subagent tool's
  // description what a subagent adds to cost roughly halved subagent spawns.
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    if ((await getMode($)) === 'off') return described
    return {
      ...described,
      description:
        described.description +
        `\n\nCost note (fable-router): every subagent re-reads context and its brief, and its result must be read back and checked; a team typically spends several times the tokens of doing the work directly. Spawn one only when the work splits into independent units or would not fit in this context. Fable subagents need "SCALE: <n>" on the brief's first line.`,
    }
  })

  // The label beside the model name: plain text, 🟢 Fable Router when on,
  // 🔴 when off. Text cannot be pressed in this spot (a Button always draws as
  // a button), so counts and the switch live in /fable-router.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    await read($, tick)
    const kept = await next(e)
    const mode = await getMode($)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        {kept}
        {mode === 'off' ? (
          <Text>🔴 FR off</Text>
        ) : (
          <Text>
            {footerLine()}
            {stats.fableRefused > 0 && <Text color="red">{` ✕${stats.fableRefused}`}</Text>}
          </Text>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'fable-router' }, async ($, e) => {
    const [cmd, arg] = e.args.trim().split(/\s+/)
    if (cmd === 'on' || cmd === 'off') {
      await $.store.set('mode', cmd)
      showStatus($, cmd)
      return { text: `fable-router ${cmd === 'on' ? 'on: routing policy and Fable gate active' : 'off: Claude Code default behaviour'}.` }
    }
    if (cmd === 'threshold') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 0) return { text: 'Usage: /fable-router threshold <whole number>' }
      await $.store.set('threshold', n)
      return { text: `Fable gate threshold set to SCALE ≥ ${n}.` }
    }
    const mode = await getMode($)
    return {
      text: [
        `fable-router: ${mode}, threshold SCALE ≥ ${await getThreshold($)}`,
        `Haiku scouts: ${stats.haikuScouts} · Sonnet workers: ${stats.workers} · Opus (in place of inherited Fable): ${stats.opusDefaults}`,
        `Fable allowed: ${stats.fableAllowed} · Fable refused (too small): ${stats.fableRefused}`,
        'Commands: /fable-router on | off | threshold <n> | stats',
      ].join('\n'),
    }
  })
}
