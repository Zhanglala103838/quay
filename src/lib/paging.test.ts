import { describe, it, expect } from 'vitest'
import { pageCount, clampPage, pageOf } from './paging'

describe('pageCount', () => {
  it('空集也算 1 页', () => expect(pageCount(0, 4)).toBe(1))
  it('整除', () => expect(pageCount(4, 4)).toBe(1))
  it('有余数进位', () => expect(pageCount(5, 4)).toBe(2))
  it('单格 N 个 = N 页', () => expect(pageCount(10, 1)).toBe(10))
  it('capacity 非法回退 1 页', () => expect(pageCount(8, 0)).toBe(1))
})

describe('clampPage', () => {
  it('越上界回退末页', () => expect(clampPage(5, 8, 4)).toBe(1)) // 8/4=2 页,末页=1
  it('负数归 0', () => expect(clampPage(-1, 8, 4)).toBe(0))
  it('范围内不变', () => expect(clampPage(1, 10, 4)).toBe(1)) // 10/4=3 页
  it('空集归 0', () => expect(clampPage(3, 0, 4)).toBe(0))
})

describe('pageOf', () => {
  it('第 6 个(0起)在四格的第 1 页', () => expect(pageOf(6, 4)).toBe(1))
  it('单格下第 7 个在第 7 页', () => expect(pageOf(7, 1)).toBe(7))
  it('首个在第 0 页', () => expect(pageOf(0, 2)).toBe(0))
  it('负 index 归 0', () => expect(pageOf(-1, 4)).toBe(0))
})
