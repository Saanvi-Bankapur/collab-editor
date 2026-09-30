/**
 * A stand-in AI API so AI features can be tested without a key or network. It speaks both formats:
 *   OpenAI-compatible (Groq etc.): AI_PROVIDER=openai AI_BASE_URL=http://localhost:4999/v1 AI_API_KEY=test
 *   Claude Messages API:           AI_PROVIDER=anthropic AI_BASE_URL=http://localhost:4999 AI_API_KEY=test
 */
import http from 'node:http'

export function startMockAI(port = 4999) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const openai = req.url === '/v1/chat/completions' && req.headers.authorization === 'Bearer test'
      const anthropic = req.url === '/v1/messages' && req.headers['x-api-key'] === 'test'
      if (!openai && !anthropic) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key or path' } }))
        return
      }
      const parsed = JSON.parse(body) as { model?: string; system?: string; messages: { role: string; content: string }[] }
      if (parsed.model === 'retired-model') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'The model `retired-model` does not exist or you do not have access to it.', code: 'model_not_found' } }))
        return
      }
      const system = openai ? parsed.messages.find((m) => m.role === 'system')!.content : parsed.system!
      const input = parsed.messages.find((m) => m.role === 'user')!.content
      let text: string
      if (system.includes('summarize')) text = `Mock summary.\n- ${input.split(/\s+/).length} words read`
      else if (system.includes('rewrite')) text = `[mock rewrite] ${input.match(/<passage>\n([\s\S]*)\n<\/passage>/)?.[1] ?? ''}`
      else text = `- Mock explanation of ${input.split('\n').filter((l) => /^[+-] /.test(l)).length} changed lines`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          openai
            ? { choices: [{ message: { role: 'assistant', content: `<think>hidden reasoning</think>${text}` } }] }
            : { content: [{ type: 'text', text }] },
        ),
      )
    })
  })
  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

if (process.argv[1]?.endsWith('mockAI.ts')) {
  startMockAI().then(() => console.log('mock AI API on http://localhost:4999 (OpenAI-compatible at /v1, Claude at /v1/messages)'))
}
