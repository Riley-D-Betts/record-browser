/**
 * The editable lists, fetched once and shared.
 *
 * Several forms need the same three lists, so this is keyed — `useFetch` dedupes on
 * the key, and one `refresh()` after an edit in Settings updates every dropdown that
 * is currently mounted rather than leaving stale options behind.
 */
export function useLists() {
  const { data, refresh, status } = useFetch('/api/lists', { key: 'editable-lists' })

  /** Only members still on offer. A retired one stays valid where it already sits. */
  function options(listKey: string, placeholder?: string) {
    const list = data.value?.find((l) => l.key === listKey)
    const items = (list?.items ?? [])
      .filter((i) => i.isActive)
      .map((i) => ({ label: i.label, value: i.key }))
    return placeholder ? [{ label: placeholder, value: UNSPECIFIED }, ...items] : items
  }

  /**
   * The label for a stored value, including retired members and values no list
   * accounts for — a detail page has to render what the row actually holds, not only
   * what could be chosen today. Unknown values fall back to the raw value so the
   * screen shows something true rather than an empty cell.
   */
  function label(listKey: string, value: string | null | undefined): string {
    if (!value) return ''
    const list = data.value?.find((l) => l.key === listKey)
    return list?.items.find((i) => i.key === value)?.label ?? value
  }

  return { lists: data, refresh, status, options, label }
}

/** Nuxt UI's USelect reserves '' for "cleared", so an absent choice needs a sentinel. */
export const UNSPECIFIED = 'unspecified'
