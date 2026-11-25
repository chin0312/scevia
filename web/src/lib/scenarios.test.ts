import { describe, expect, it } from 'vitest'
import * as SC from './scenarios'

const adj = (id: string, to: number, price = 0.5) => ({ id, to, price })

describe('scenario lifecycle', () => {
  it('a new scenario starts unsaved, even when empty', () => {
    const s = SC.create('k', 'c')
    expect(SC.status(s)).toBe('new')
    expect(SC.isDirty(s)).toBe(true)
    expect(SC.statusLabel(s)).toBe('Not saved')
  })
  it('saving snapshots name and adjustments', () => {
    const s = SC.save({ ...SC.create('k', 'c', 'Plan A'), adjs: [adj('x', 10)] }, 'now')
    expect(SC.status(s)).toBe('saved')
    expect(s.saved).toEqual({ name: 'Plan A', adjs: [adj('x', 10)] })
  })
  it('renaming a saved scenario marks it modified; reverting restores the saved name', () => {
    const saved = SC.save(SC.create('k', 'c', 'Plan A'), 'now')
    const renamed = SC.rename(saved, 'Plan B')
    expect(SC.status(renamed)).toBe('modified')
    expect(SC.canRevert(renamed)).toBe(true)
    const back = SC.revert(renamed)
    expect(back.name).toBe('Plan A')
    expect(SC.status(back)).toBe('saved')
  })
  it('renaming to blank keeps the old name', () => {
    expect(SC.rename(SC.create('k', 'c', 'Plan A'), '   ').name).toBe('Plan A')
  })
  it('editing adjustments marks it modified; revert restores them', () => {
    const saved = SC.save({ ...SC.create('k', 'c'), adjs: [adj('x', 10)] }, 'now')
    const edited = { ...saved, adjs: [adj('x', 20)] }
    expect(SC.status(edited)).toBe('modified')
    expect(SC.revert(edited).adjs).toEqual([adj('x', 10)])
  })
  it('an unsaved scenario reverts to its starting adjustments', () => {
    const start = [adj('x', 10)]
    const s = { ...SC.create('draft', 'c'), adjs: [adj('x', 99)] }
    expect(SC.canRevert(s, start)).toBe(true)
    expect(SC.revert(s, start).adjs).toEqual(start)
    expect(SC.canRevert({ ...s, adjs: start }, start)).toBe(false)
  })
  it('duplicates are independent and unsaved', () => {
    const src = SC.save({ ...SC.create('a', 'c', 'Plan A'), adjs: [adj('x', 10)] }, 'now')
    const dup = SC.duplicate(src, 'b', 'd')
    expect(dup.name).toBe('Plan A (copy)')
    expect(SC.status(dup)).toBe('new')
    dup.adjs[0].to = 50
    expect(src.adjs[0].to).toBe(10)
  })
  it('saved snapshots aren’t affected by later edits', () => {
    const s = SC.save({ ...SC.create('k', 'c'), adjs: [adj('x', 10)] }, 'now')
    s.adjs[0].to = 30
    expect(s.saved!.adjs[0].to).toBe(10)
  })
})

describe('adding positions to a scenario', () => {
  it('adds only positions that are absent, copies them, and reports what was skipped', () => {
    const s = { ...SC.create('k', 'c'), adjs: [adj('a', 100)] }
    const input = [adj('a', 999), adj('b', 50)]
    const r = SC.addPositions(s, input)
    expect(r.added).toEqual(['b'])
    expect(r.skipped).toEqual(['a'])
    expect(r.scenario.adjs).toEqual([adj('a', 100), adj('b', 50)])
    expect(r.scenario.adjs[1]).not.toBe(input[1])
    expect(s.adjs).toHaveLength(1) // original untouched
  })
  it('adding nothing new leaves the scenario equal', () => {
    const s = { ...SC.create('k', 'c'), adjs: [adj('a', 1)] }
    expect(SC.addPositions(s, [adj('a', 2)]).scenario.adjs).toEqual(s.adjs)
  })
})
