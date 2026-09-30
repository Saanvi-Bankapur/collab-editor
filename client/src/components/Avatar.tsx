import { initials } from '../api'

export function Avatar({ name, color, idle, title, size = 30 }: {
  name: string
  color: string
  idle?: boolean
  title?: string
  size?: number
}) {
  return (
    <span
      className={'avatar' + (idle ? ' idle' : '')}
      style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}
      title={title ?? name}
    >
      {initials(name)}
    </span>
  )
}
