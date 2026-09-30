import { Link } from 'react-router-dom'
import { timeAgo, type Activity } from '../api'
import { Avatar } from './Avatar'

/** Human-readable sentence for an activity row. */
export function describeActivity(a: Activity, showDoc: boolean) {
  const doc = showDoc ? <Link to={`/d/${a.doc_id}`}>{a.doc_title}</Link> : 'the document'
  const d = a.data ?? {}
  switch (a.type) {
    case 'created':
      return d.source?.startsWith('template:') ? (
        <>created {doc} from the <i>{d.source.slice(9)}</i> template</>
      ) : d.source?.startsWith('import:') ? (
        <>imported {doc} from <i>{d.source.slice(7)}</i></>
      ) : (
        <>created {doc}</>
      )
    case 'renamed':
      return <>renamed {showDoc ? doc : 'the document'} from “{d.from}”</>
    case 'edited':
      return <>edited {doc}</>
    case 'shared':
      return <>shared {doc} with {d.targetName} ({d.role})</>
    case 'role_changed':
      return <>changed {d.targetName}’s access to {d.role} on {doc}</>
    case 'unshared':
      return <>removed {d.targetName} from {doc}</>
    case 'link_created':
      return <>created a “can {d.role === 'editor' ? 'edit' : d.role === 'commenter' ? 'comment' : 'view'}” link for {doc}</>
    case 'joined_via_link':
      return <>joined {doc} via a link ({d.role})</>
    case 'version_saved':
      return <>saved version “{d.name}” of {doc}</>
    case 'version_restored':
      return <>restored {doc} to “{d.name}”</>
    case 'mentioned':
      return <>mentioned {d.targetName} in {doc}</>
    default:
      return <>{a.type} {doc}</>
  }
}

export function ActivityList({ items, showDoc = false }: { items: Activity[]; showDoc?: boolean }) {
  if (items.length === 0) return <p className="muted small">No activity yet.</p>
  return (
    <ul className="activity-list">
      {items.map((a) => (
        <li key={a.id}>
          <Avatar name={a.actor_name ?? a.data?.guestName ?? '?'} color={a.actor_color ?? '#9ca3af'} size={24} />
          <div>
            <div className="small">
              <b>{a.actor_name ?? (a.data?.guestName ? `${a.data.guestName} (guest)` : 'Someone')}</b> {describeActivity(a, showDoc)}
            </div>
            {a.type === 'edited' && <EditDetail data={a.data} />}
            <div className="muted tiny">{timeAgo(a.created_at)}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** What an edit changed: words added / removed with short previews. */
function EditDetail({ data }: { data: Record<string, string | number> }) {
  const added = Number(data?.addedWords ?? 0)
  const removed = Number(data?.removedWords ?? 0)
  if (!added && !removed && !data?.added && !data?.removed) return null
  return (
    <div className="edit-detail small">
      {(added > 0 || data.added) && (
        <div>
          <span className="add">+{added} word{added === 1 ? '' : 's'}</span>
          {data.added && <span className="muted">: “{String(data.added)}”</span>}
        </div>
      )}
      {(removed > 0 || data.removed) && (
        <div>
          <span className="del">−{removed} word{removed === 1 ? '' : 's'}</span>
          {data.removed && <span className="muted">: “{String(data.removed)}”</span>}
        </div>
      )}
    </div>
  )
}
