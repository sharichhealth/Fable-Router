import { expect, test } from 'claude-code/testing'

const stub = (on: any, store: Record<string, unknown> = {}) => {
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => { seen.push(e); return { result: 'ran' } })
  return seen
}

test('Explore is moved to Haiku at low effort', async ($, on) => {
  const seen = stub(on)
  await $.tool.call({ tool: 'Agent', description: 'find', prompt: 'find x', subagent_type: 'Explore' } as any)
  expect(seen[0].model).toBe('haiku')
  expect(seen[0].effort).toBe('low')
})

test('a Fable call without SCALE is refused', async ($, on) => {
  const seen = stub(on)
  const r: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'fix typo', model: 'fable' } as any)
  expect(String(r.deny)).toMatch(/SCALE/)
  expect(seen.length).toBe(0)
})

test('a small SCALE is refused, a big one runs', async ($, on) => {
  const seen = stub(on)
  const small: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'SCALE: 2\nPLAN', subagent_type: 'fable-router:architect' } as any)
  expect(String(small.deny)).toMatch(/under the threshold/)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'SCALE: 50\nPLAN read 50 scripts', subagent_type: 'fable-router:architect' } as any)
  expect(seen.length).toBe(1)
})

test('JUDGMENT lets one hard problem through', async ($, on) => {
  const seen = stub(on)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'SCALE: 0\nJUDGMENT: race condition design', model: 'fable' } as any)
  expect(seen.length).toBe(1)
})

test('off passes everything through', async ($, on) => {
  const seen = stub(on, { mode: 'off' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', model: 'fable' } as any)
  expect(seen.length).toBe(1)
  expect(seen[0].model).toBe('fable')
})

test('under a Fable main loop, a general-purpose agent with no model runs on Opus', async ($, on) => {
  const seen = stub(on)
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'do x', subagent_type: 'general-purpose' } as any)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'do y' } as any)
  expect(seen[0].model).toBe('opus')
  expect(seen[1].model).toBe('opus')
})

test('under a Fable main loop, an explicit model and custom agents are left alone', async ($, on) => {
  const seen = stub(on)
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', subagent_type: 'general-purpose', model: 'haiku' } as any)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', subagent_type: 'my-agent' } as any)
  expect(seen[0].model).toBe('haiku')
  expect(seen[1].model).toBe(undefined)
})

test('under an Opus main loop, inheriting agents are left alone', async ($, on) => {
  const seen = stub(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', subagent_type: 'general-purpose' } as any)
  expect(seen[0].model).toBe(undefined)
})

test('the footer shows each model\'s count as text, and off when off', async ($, on) => {
  const store: Record<string, unknown> = {}
  stub(on, store)
  const ui = await $.ui.mount({ plugin: 'fable-router', component: 'SessionMode', surface: 'desktop', props: { modes: [] } } as any)
  expect(await ui.findAll({ type: 'Button' } as any)).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /^H\d/ } as any))?.text).toMatch(/^H\d+ S\d+ O\d+ F\d+$/)
  await ui.unmount()
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'fix typo', model: 'fable' } as any)
  const uiR = await $.ui.mount({ plugin: 'fable-router', component: 'SessionMode', surface: 'desktop', props: { modes: [] } } as any)
  expect((await uiR.find({ type: 'Text', text: /^ ✕\d+$/ } as any))?.props?.color).toBe('red')
  await uiR.unmount()
  store.mode = 'off'
  const ui2 = await $.ui.mount({ plugin: 'fable-router', component: 'SessionMode', surface: 'desktop', props: { modes: [] } } as any)
  expect((await ui2.find({ type: 'Text', text: /FR off/ } as any))?.text).toBe('🔴 FR off')
  await ui2.unmount()
})

test('the Fable-only rules are added only under a Fable main loop', async ($, on) => {
  stub(on)
  on('prompt.compose', () => ({ sections: [] }))
  let model = 'claude-fable-5-2'
  const text = async () => ((await $.prompt.compose({ sections: [], promptModel: model, outputStyle: null, tools: [], traits: [], surfaces: [] } as any)) as any).sections.map((s: any) => s.text).join('\\n')
  const fable = await text()
  expect(fable.includes('Main model is Fable')).toBe(true)
  expect(fable.includes('model: "opus"')).toBe(true)
  model = 'claude-opus-5-5'
  expect((await text()).includes('Main model is Fable')).toBe(false)
})
