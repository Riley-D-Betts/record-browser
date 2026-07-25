/**
 * Seeds the built-in type catalog, a first admin, and a demo schema.
 *
 * The demo schema is deliberately imperfect: it contains a circular dependency, a
 * reference whose type disagrees with its source, an orphan record, and an unused
 * field. Every report therefore has a positive case on a fresh install, which is the
 * only way to tell a working report from one that silently finds nothing.
 *
 * Pass --no-demo to seed only the type catalog and the admin user.
 */
import { eq } from 'drizzle-orm'
import { createDb, dataTypes, fieldDependencies, fields, modules, records, relationships, users } from '../server/db'
import { setFieldSource } from '../server/services/fieldSource'
import { hashPassword } from '../server/lib/password'
import { BUILTIN_DATA_TYPES } from '../shared/constants'

const db = createDb(process.env.NUXT_DATABASE_PATH ?? '.data/record-browser.db')
const withDemo = !process.argv.includes('--no-demo')

// --- type catalog -----------------------------------------------------------

let typesAdded = 0
for (const [i, type] of BUILTIN_DATA_TYPES.entries()) {
  const existing = db.select().from(dataTypes).where(eq(dataTypes.key, type.key)).all()[0]
  if (existing) continue
  db.insert(dataTypes)
    .values({
      key: type.key,
      label: type.label,
      category: type.category,
      isBuiltin: true,
      supportsLength: 'supportsLength' in type ? type.supportsLength : false,
      supportsPrecision: 'supportsPrecision' in type ? type.supportsPrecision : false,
      supportsScale: 'supportsScale' in type ? type.supportsScale : false,
      supportsOptions: 'supportsOptions' in type ? type.supportsOptions : false,
      sortOrder: i,
    })
    .run()
  typesAdded++
}
console.log(`Data types: ${typesAdded} added, ${BUILTIN_DATA_TYPES.length - typesAdded} already present`)

const typeId = (key: string) =>
  db.select().from(dataTypes).where(eq(dataTypes.key, key)).all()[0]!.id

// --- first admin ------------------------------------------------------------

const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase()
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-please'

let admin = db.select().from(users).where(eq(users.email, adminEmail)).all()[0]
if (!admin) {
  admin = db
    .insert(users)
    .values({
      email: adminEmail,
      name: process.env.SEED_ADMIN_NAME ?? 'Administrator',
      passwordHash: await hashPassword(adminPassword),
      role: 'admin',
    })
    .returning()
    .all()[0]!
  console.log(`Admin created: ${adminEmail} / ${adminPassword}`)
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log('  ^ default password — change it after first login')
  }
} else {
  console.log(`Admin already exists: ${adminEmail}`)
}

// --- demo schema ------------------------------------------------------------

if (!withDemo) {
  console.log('Skipping demo data (--no-demo)')
  process.exit(0)
}

if (db.select().from(records).all().length > 0) {
  console.log('Catalog already has records — skipping demo data')
  process.exit(0)
}

const actor = { createdBy: admin.id, updatedBy: admin.id }

const mod = (key: string, name: string, color: string, sortOrder: number) =>
  db.insert(modules).values({ key, name, color, sortOrder }).returning().all()[0]!

const sales = mod('sales', 'Sales', '#3b82f6', 0)
const billing = mod('billing', 'Billing', '#8b5cf6', 1)
const ops = mod('operations', 'Operations', '#10b981', 2)

const rec = (
  moduleId: string | null,
  apiName: string,
  label: string,
  origin: 'native' | 'custom',
  externalId: string | null,
  description: string,
) =>
  db
    .insert(records)
    .values({ moduleId, apiName, label, origin, externalId, description, ...actor })
    .returning()
    .all()[0]!

const account = rec(sales.id, 'Account', 'Account', 'native', '01I000000000001', 'A customer organisation.')
const contact = rec(sales.id, 'Contact', 'Contact', 'native', '01I000000000002', 'A person at an account.')
const order = rec(sales.id, 'Sales_Order', 'Sales Order', 'custom', '01I000000000003', 'A confirmed customer order.')
const orderLine = rec(sales.id, 'Sales_Order_Line', 'Sales Order Line', 'custom', '01I000000000004', 'One product on an order.')
const product = rec(ops.id, 'Product', 'Product', 'native', '01I000000000005', 'A sellable item.')
const invoice = rec(billing.id, 'Invoice', 'Invoice', 'custom', '01I000000000006', 'A billing document raised from an order.')
const payment = rec(billing.id, 'Payment', 'Payment', 'custom', '01I000000000007', 'Money received against an invoice.')
// Deliberately in no relationship — the orphan report needs a positive case.
const auditNote = rec(ops.id, 'Audit_Note', 'Audit Note', 'custom', null, 'Free-text note left by a quality auditor. Not linked to anything.')

let order_ = 0
function field(
  record: { id: string },
  apiName: string,
  label: string,
  typeKey: string,
  opts: {
    origin?: 'native' | 'custom'
    externalId?: string | null
    required?: boolean
    pk?: boolean
    description?: string
  } = {},
) {
  return db
    .insert(fields)
    .values({
      recordId: record.id,
      apiName,
      label,
      dataTypeId: typeId(typeKey),
      origin: opts.origin ?? 'custom',
      externalId: opts.externalId ?? null,
      isRequired: opts.required ?? false,
      isPrimaryKey: opts.pk ?? false,
      description: opts.description ?? null,
      sortOrder: order_++,
      ...actor,
    })
    .returning()
    .all()[0]!
}

// Account
const accountId = field(account, 'Id', 'Account ID', 'text', { origin: 'native', pk: true, required: true })
const accountName = field(account, 'Name', 'Account Name', 'text', { origin: 'native', required: true, externalId: '00N000000000001' })
const accountTier = field(account, 'Tier', 'Customer Tier', 'enum', { description: 'Bronze / Silver / Gold. Drives discount rate.' })
const accountCreditLimit = field(account, 'Credit_Limit', 'Credit Limit', 'currency')
// Never referenced, not required, not a PK — the unused-field report needs this.
field(account, 'Legacy_Region_Code', 'Legacy Region Code', 'text', { description: 'Left over from the pre-2019 system. Believed unused.' })

// Contact
const contactId = field(contact, 'Id', 'Contact ID', 'text', { origin: 'native', pk: true, required: true })
const contactAccount = field(contact, 'Account_Id', 'Account', 'reference', { origin: 'native', required: true })
field(contact, 'Email', 'Email Address', 'email', { origin: 'native' })
const contactAccountName = field(contact, 'Account_Name', 'Account Name', 'text', { description: 'Denormalised from the parent account for list views.' })

// Product
const productId = field(product, 'Id', 'Product ID', 'text', { origin: 'native', pk: true, required: true })
const productPrice = field(product, 'List_Price', 'List Price', 'currency', { required: true })

// Sales Order
const orderId = field(order, 'Id', 'Order ID', 'text', { pk: true, required: true })
const orderAccount = field(order, 'Account_Id', 'Account', 'reference', { required: true })
const orderDiscount = field(order, 'Discount_Rate', 'Discount Rate', 'decimal')
const orderSubtotal = field(order, 'Subtotal', 'Subtotal', 'currency')
const orderTotal = field(order, 'Total', 'Order Total', 'currency')

// Sales Order Line
const lineId = field(orderLine, 'Id', 'Line ID', 'text', { pk: true, required: true })
const lineOrder = field(orderLine, 'Order_Id', 'Order', 'reference', { required: true })
const lineProduct = field(orderLine, 'Product_Id', 'Product', 'reference', { required: true })
const lineQty = field(orderLine, 'Quantity', 'Quantity', 'integer', { required: true })
const lineUnitPrice = field(orderLine, 'Unit_Price', 'Unit Price', 'currency')
const lineAmount = field(orderLine, 'Amount', 'Line Amount', 'currency')

// Invoice
const invoiceId = field(invoice, 'Id', 'Invoice ID', 'text', { pk: true, required: true })
const invoiceOrder = field(invoice, 'Order_Id', 'Order', 'reference', { required: true })
const invoiceAmount = field(invoice, 'Amount_Due', 'Amount Due', 'currency')
// Type mismatch on purpose: sources from a currency field but is typed text.
const invoiceAccountTier = field(invoice, 'Account_Tier', 'Account Tier', 'text', { description: 'Copied from the account. Note the type disagrees with its source.' })
const invoiceSyncedTotal = field(invoice, 'Synced_Total', 'Synced Total', 'currency', { description: 'Written nightly by the ERP integration, not by a person.' })

// Payment
const paymentId = field(payment, 'Id', 'Payment ID', 'text', { pk: true, required: true })
const paymentInvoice = field(payment, 'Invoice_Id', 'Invoice', 'reference', { required: true })
field(payment, 'Amount', 'Amount Received', 'currency', { required: true })

// Audit Note (orphan record)
field(auditNote, 'Id', 'Note ID', 'text', { pk: true, required: true })
field(auditNote, 'Body', 'Note Body', 'long_text')

// --- provenance -------------------------------------------------------------

const source = (fieldId: string, src: Parameters<typeof setFieldSource>[2]) =>
  setFieldSource(db, fieldId, src, { allowCycles: true })

source(contactAccountName.id, { sourceKind: 'reference', sourceFieldId: accountName.id, sourceNotes: null })
source(lineUnitPrice.id, { sourceKind: 'reference', sourceFieldId: productPrice.id, sourceNotes: null })
source(lineAmount.id, {
  sourceKind: 'derived',
  sourceExpression: 'Quantity * Unit_Price',
  derivationLanguage: 'formula',
  dependsOn: [lineQty.id, lineUnitPrice.id],
  sourceNotes: null,
})
source(orderSubtotal.id, {
  sourceKind: 'derived',
  sourceExpression: 'SUM(Sales_Order_Line.Amount)',
  derivationLanguage: 'formula',
  dependsOn: [lineAmount.id],
  sourceNotes: null,
})
source(orderTotal.id, {
  sourceKind: 'derived',
  sourceExpression: 'Subtotal * (1 - Discount_Rate)',
  derivationLanguage: 'formula',
  dependsOn: [orderSubtotal.id, orderDiscount.id],
  sourceNotes: null,
})
source(invoiceAmount.id, { sourceKind: 'reference', sourceFieldId: orderTotal.id, sourceNotes: null })
// Type mismatch: text field sourcing from an enum.
source(invoiceAccountTier.id, { sourceKind: 'reference', sourceFieldId: accountTier.id, sourceNotes: null })
// Externally populated — looks like user entry but a nightly job writes it.
source(invoiceSyncedTotal.id, {
  sourceKind: 'user_entry',
  isExternallyPopulated: true,
  sourceNotes: 'Written by the nightly ERP sync job (JOB_INV_SYNC).',
})

/*
 * A deliberate circular dependency, so the cycles report and the traversal guard both
 * have something real to find:
 *
 *   Account.Credit_Limit  <- Order.Total
 *   Order.Discount_Rate   <- Account.Credit_Limit
 *   Order.Total           <- Order.Discount_Rate   (already set above)
 *
 * Written straight to the edge table because setFieldSource would — correctly —
 * refuse to create it interactively.
 */
source(accountCreditLimit.id, {
  sourceKind: 'derived',
  sourceExpression: 'GREATEST(Credit_Limit, Sales_Order.Total)',
  derivationLanguage: 'formula',
  dependsOn: [orderTotal.id],
  sourceNotes: null,
})
db.insert(fieldDependencies)
  .values({
    fieldId: orderDiscount.id,
    sourceFieldId: accountCreditLimit.id,
    kind: 'derived',
    note: 'Seeded circular dependency — demonstrates cycle detection.',
  })
  .run()
db.update(fields)
  .set({
    sourceKind: 'derived',
    sourceExpression: 'TIER_DISCOUNT(Account.Credit_Limit)',
    derivationLanguage: 'formula',
  })
  .where(eq(fields.id, orderDiscount.id))
  .run()

// --- relationships ----------------------------------------------------------

const rel = (
  parent: { id: string },
  child: { id: string },
  viaField: { id: string } | null,
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many',
  identifying: boolean,
  label: string,
) =>
  db
    .insert(relationships)
    .values({
      parentRecordId: parent.id,
      childRecordId: child.id,
      viaFieldId: viaField?.id ?? null,
      cardinality,
      isIdentifying: identifying,
      onDelete: identifying ? 'cascade' : 'restrict',
      label,
      ...actor,
    })
    .returning()
    .all()[0]!

rel(account, contact, contactAccount, 'one_to_many', false, 'Account has many contacts')
rel(account, order, orderAccount, 'one_to_many', false, 'Account has many orders')
rel(order, orderLine, lineOrder, 'one_to_many', true, 'Order has many lines')
rel(product, orderLine, lineProduct, 'one_to_many', false, 'Product appears on many order lines')
rel(order, invoice, invoiceOrder, 'one_to_many', false, 'Order raises invoices')
rel(invoice, payment, paymentInvoice, 'one_to_many', true, 'Invoice receives payments')

void accountId
void contactId
void productId
void orderId
void lineId
void invoiceId
void paymentId

const counts = {
  modules: db.select().from(modules).all().length,
  records: db.select().from(records).all().length,
  fields: db.select().from(fields).all().length,
  dependencies: db.select().from(fieldDependencies).all().length,
  relationships: db.select().from(relationships).all().length,
}
console.log('Demo catalog seeded:', counts)
console.log('Deliberate findings: 1 circular dependency, 1 type mismatch, 1 orphan record, 1 unused field, 1 externally-populated field')
