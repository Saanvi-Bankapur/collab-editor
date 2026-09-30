/** Document templates. Content is HTML that TipTap parses into the collaborative document. */
export interface Template {
  id: string
  name: string
  description: string
  icon: string
  title: () => string
  html: () => string
}

const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

const task = (text: string, checked = false) =>
  `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p></li>`

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank document',
    description: 'Start from scratch.',
    icon: '▢',
    title: () => 'Untitled document',
    html: () => '',
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Agenda, notes, decisions and action items.',
    icon: '🗓',
    title: () => `Meeting notes – ${today()}`,
    html: () => `
      <h1>Meeting notes</h1>
      <p><strong>Date:</strong> ${today()} · <strong>Attendees:</strong> type @ to mention people</p>
      <h2>Agenda</h2>
      <ol><li><p>Updates since last meeting</p></li><li><p>Discussion</p></li><li><p>Next steps</p></li></ol>
      <h2>Notes</h2>
      <p></p>
      <h2>Decisions</h2>
      <ul><li><p></p></li></ul>
      <h2>Action items</h2>
      <ul data-type="taskList">${task('Owner — task — due date')}${task('')}</ul>`,
  },
  {
    id: 'spec',
    name: 'Project spec',
    description: 'Problem, goals, design, milestones and risks.',
    icon: '📐',
    title: () => 'Project spec: ',
    html: () => `
      <h1>Project spec</h1>
      <table><tbody>
        <tr><th><p>Author</p></th><td><p></p></td></tr>
        <tr><th><p>Status</p></th><td><p>Draft</p></td></tr>
        <tr><th><p>Last updated</p></th><td><p>${today()}</p></td></tr>
      </tbody></table>
      <h2>Problem</h2><p>What problem are we solving, and for whom?</p>
      <h2>Goals</h2><ul><li><p></p></li></ul>
      <h2>Non-goals</h2><ul><li><p></p></li></ul>
      <h2>Proposed design</h2><p></p>
      <pre><code class="language-typescript">// API sketch
interface Example {
  id: string
}</code></pre>
      <h2>Milestones</h2>
      <table><tbody>
        <tr><th><p>Milestone</p></th><th><p>Owner</p></th><th><p>Target date</p></th></tr>
        <tr><td><p>MVP</p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p>Launch</p></td><td><p></p></td><td><p></p></td></tr>
      </tbody></table>
      <h2>Risks and open questions</h2><ul><li><p></p></li></ul>`,
  },
  {
    id: 'weekly',
    name: 'Weekly status',
    description: 'Done, in progress, blocked, next week.',
    icon: '📊',
    title: () => `Weekly status – ${today()}`,
    html: () => `
      <h1>Weekly status</h1>
      <p>Week of ${today()}</p>
      <h2>✅ Done</h2><ul><li><p></p></li></ul>
      <h2>🚧 In progress</h2><ul><li><p></p></li></ul>
      <h2>⛔ Blocked</h2><ul><li><p></p></li></ul>
      <h2>Next week</h2><ul data-type="taskList">${task('')}</ul>`,
  },
  {
    id: 'retro',
    name: 'Retrospective',
    description: 'What went well, what didn’t, what we’ll change.',
    icon: '🔁',
    title: () => `Retro – ${today()}`,
    html: () => `
      <h1>Retrospective</h1>
      <h2>What went well</h2><ul><li><p></p></li></ul>
      <h2>What didn’t go well</h2><ul><li><p></p></li></ul>
      <h2>What we’ll try next</h2><ul data-type="taskList">${task('')}</ul>`,
  },
  {
    id: 'study',
    name: 'Lecture / study notes',
    description: 'Key ideas, definitions, examples, questions.',
    icon: '🎓',
    title: () => 'Lecture notes: ',
    html: () => `
      <h1>Lecture notes</h1>
      <p><strong>Course:</strong> · <strong>Date:</strong> ${today()}</p>
      <h2>Key ideas</h2><ul><li><p></p></li></ul>
      <h2>Definitions</h2>
      <table><tbody><tr><th><p>Term</p></th><th><p>Meaning</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>
      <h2>Examples</h2><pre><code></code></pre>
      <h2>Questions to review</h2><ul data-type="taskList">${task('')}</ul>`,
  },
]
