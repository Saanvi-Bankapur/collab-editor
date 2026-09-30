/** The AI client speaks both the OpenAI-compatible format (Groq etc.) and Claude's format. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { startMockAI } from './mockAI.js'
import { config } from '../src/config.js'
import { askAI, aiEnabled, currentModel } from '../src/ai.js'

let server: Server
const PORT = 4998
before(async () => {
  server = await startMockAI(PORT)
})
after(() => server.close())

test('OpenAI-compatible provider (Groq): system+user messages, <think> blocks stripped', async () => {
  Object.assign(config, { aiProvider: 'openai', aiApiKey: 'test', aiBaseUrl: `http://localhost:${PORT}/v1`, aiModel: 'llama-3.3-70b-versatile' })
  assert.equal(aiEnabled(), true)
  const out = await askAI('You summarize documents', 'one two three')
  assert.equal(out, 'Mock summary.\n- 3 words read')
})

test('Claude provider', async () => {
  Object.assign(config, { aiProvider: 'anthropic', aiApiKey: 'test', aiBaseUrl: `http://localhost:${PORT}`, aiModel: 'claude-sonnet-5' })
  assert.match(await askAI('You rewrite a selected passage', 'Task: x\n\n<passage>\nhello\n</passage>'), /\[mock rewrite\] hello/)
})

test('a retired model switches to the fallback model automatically', async () => {
  Object.assign(config, { aiProvider: 'openai', aiApiKey: 'test', aiBaseUrl: `http://localhost:${PORT}/v1`, aiModel: 'retired-model', aiFallbackModel: 'openai/gpt-oss-120b' })
  assert.equal(await askAI('You summarize documents', 'a b'), 'Mock summary.\n- 2 words read')
  assert.equal(currentModel(), 'openai/gpt-oss-120b')
})

test('a retired model without a fallback explains how to fix it', async () => {
  const { resetModelOverride } = await import('../src/ai.js')
  resetModelOverride()
  Object.assign(config, { aiModel: 'retired-model', aiFallbackModel: '' })
  await assert.rejects(askAI('s', 'u'), /retired-model.*Set AI_MODEL/)
})

test('a rejected key gives a clear error', async () => {
  Object.assign(config, { aiProvider: 'openai', aiApiKey: 'wrong', aiBaseUrl: `http://localhost:${PORT}/v1` })
  await assert.rejects(askAI('s', 'u'), /API key was rejected/)
})

test('no key => AI disabled', async () => {
  Object.assign(config, { aiApiKey: '' })
  assert.equal(aiEnabled(), false)
  await assert.rejects(askAI('s', 'u'), /not configured/)
})
