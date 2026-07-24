import { useEffect, useState } from 'react'

/** Changes whenever root theme classes/tokens may have changed. */
export function usePluginPanelThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((current) => current + 1))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    return () => observer.disconnect()
  }, [])
  return revision
}
