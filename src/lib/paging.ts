/// 工作区分屏的纯逻辑:页数、页码钳制、条目→页 反推。无副作用,供 store/组件复用并单测。
export type Layout = 1 | 2 | 4

/** 总页数。空集也算 1 页(空态由上层渲染)。capacity 非法时回退 1。 */
export function pageCount(total: number, capacity: number): number {
  if (capacity <= 0) return 1
  return Math.max(1, Math.ceil(total / capacity))
}

/** 把 page 钳制到 [0, pageCount-1]。 */
export function clampPage(page: number, total: number, capacity: number): number {
  const last = pageCount(total, capacity) - 1
  if (page < 0) return 0
  if (page > last) return last
  return page
}

/** 第 index 个条目(0 起)所在页(0 起)。index<0 或 capacity 非法 → 0。 */
export function pageOf(index: number, capacity: number): number {
  if (index < 0 || capacity <= 0) return 0
  return Math.floor(index / capacity)
}
