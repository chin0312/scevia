/* The one editor for the user-classifiable relationship (BTC × ETH). Used by Risk, Scenario Lab and event details;
   all of them read and write the same shared state, so there is never a second copy of the assumption. */
import { useState } from 'react'
import { REL_TEXT, useRelations, type RelClass } from '../data/relations'
import { Modal, useToast } from './overlays'
import { Button, cx } from './ui'

export function RelationshipModal({ current, onClose }: { current: RelClass; onClose: () => void }) {
  const { setCrypto } = useRelations()
  const toast = useToast()
  const [choice, setChoice] = useState<RelClass>(current)
  return (
    <Modal title="Classify relationship" sub="Bitcoin above $150k (Dec 31) · ETH ETF inflows > $1B (Nov)" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { setCrypto(choice); onClose(); toast('Relationship saved') }}>Save</Button></>}>
      <div role="radiogroup" aria-label="Relationship" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {([['related', 'They share drivers. All combinations stay possible; outcomes are never netted.'], ['mutex', 'Both can’t resolve YES. That combination is excluded from best/worst cases in Risk and Scenario Lab.'], ['unknown', 'Keep every combination possible and flag it as an unmodeled dependency.']] as const).map(([k, d]) => (
          <label key={k} className={cx('choice', choice === k && 'on')}><input type="radio" name="rel" checked={choice === k} onChange={() => setChoice(k)} /><span>{REL_TEXT[k].label}<small>{d}</small></span></label>
        ))}
        <label className="choice" style={{ opacity: 0.5, cursor: 'not-allowed' }}><input type="radio" name="rel" disabled /><span>{REL_TEXT.equivalent.label}<small>Not available: these contracts resolve on different rules and dates. Similar titles don’t mean the same settlement.</small></span></label>
      </div>
      <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>This setting is shared by Risk and Scenario Lab.</p>
    </Modal>
  )
}
