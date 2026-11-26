import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { portfolios, users } from '../db/schema.js'
import { fxEvidenceMode, loadFx, reportingCurrency, selectRate } from '../fx/reference.js'
import { z } from 'zod'

const reportingPreference = { currency: users.reportingCurrency, fiatSource: users.fiatReferenceSource,
  stablecoinSource: users.stablecoinReferenceSource }
const preferredSource = z.string().min(1).max(120).nullable().optional()

export function registerOwnerPreferences(app: FastifyInstance, db: Database) {
  app.get('/fx/reference', async (request, reply) => {
    const query = z.object({ base: z.enum(['USD', 'SGD', 'EUR', 'GBP', 'MYR', 'USDC', 'PUSD']),
      currency: reportingCurrency, mode: fxEvidenceMode.optional(), source: z.string().max(120).optional(), asOf: z.iso.datetime({ offset: true }).optional() }).strict().safeParse(request.query)
    if (!query.success) return reply.code(422).send({ error: { code: 'invalid_fx_scope' } })
    const asOf = new Date(query.data.asOf ?? Date.now()).toISOString()
    const [preference] = await db.select(reportingPreference).from(users).where(eq(users.id, request.principalId!)).limit(1)
    return { base: query.data.base, currency: query.data.currency, asOf,
      ...selectRate(await loadFx(db, asOf, asOf, { assets: [query.data.base], currency: query.data.currency, ...(query.data.mode ? { mode: query.data.mode } : {}) }),
        query.data.base, query.data.currency, asOf, { ...preference, mode: query.data.mode, source: query.data.source }), evidenceMode: query.data.mode ?? 'knowledge' }
  })
  app.get('/simulations', async (request) => {
    const [collection] = await db.select({ id: portfolios.id }).from(portfolios).where(and(
      eq(portfolios.ownerId, request.principalId!), eq(portfolios.simulationOnly, true))).limit(1)
    return { collection: collection ?? null }
  })
  app.post('/simulations', async (request, reply) => {
    const owner = request.principalId!
    const id = await db.transaction(async (tx) => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, owner)).for('update')
      if (!user) return null
      const [existing] = await tx.select({ id: portfolios.id }).from(portfolios)
        .where(and(eq(portfolios.ownerId, owner), eq(portfolios.simulationOnly, true))).limit(1)
      if (existing) return existing.id
      const [row] = await tx.insert(portfolios).values({ ownerId: owner, name: 'Independent simulations', simulationOnly: true })
        .returning({ id: portfolios.id })
      return row!.id
    })
    return id ? { collection: { id } } : reply.code(404).send({ error: { code: 'not_found' } })
  })
  app.get('/preferences/reporting', async (request) => {
    const [row] = await db.select(reportingPreference).from(users).where(eq(users.id, request.principalId!)).limit(1)
    return { currency: row?.currency ?? 'USD', fiatSource: row?.fiatSource ?? null, stablecoinSource: row?.stablecoinSource ?? null, methodology: 'point_in_time_reference' }
  })
  app.put('/preferences/reporting', async (request, reply) => {
    const parsed = z.object({ currency: reportingCurrency, fiatSource: preferredSource, stablecoinSource: preferredSource }).strict().safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid_reporting_currency' } })
    const [row] = await db.update(users).set({ reportingCurrency: parsed.data.currency,
      ...(parsed.data.fiatSource !== undefined ? { fiatReferenceSource: parsed.data.fiatSource } : {}),
      ...(parsed.data.stablecoinSource !== undefined ? { stablecoinReferenceSource: parsed.data.stablecoinSource } : {}) }).where(eq(users.id, request.principalId!))
      .returning(reportingPreference)
    return row ?? reply.code(404).send({ error: { code: 'not_found' } })
  })
}
