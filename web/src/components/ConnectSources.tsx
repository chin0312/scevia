/* Data sources live in one place: the portfolio workspace's Sources section. `useConnect()` is the contextual
   shortcut to it (from detail panels and the portfolio menu); it navigates rather than opening a second copy. */
import { useNavigate } from 'react-router-dom'

export function useConnect() {
  const nav = useNavigate()
  return (section: 'sources' | 'coverage' | 'accounts' = 'sources') => nav(`/portfolio/${section}`)
}
