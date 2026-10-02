import { pgTable, serial, text, smallint, boolean, timestamp, integer, date, char } from 'drizzle-orm/pg-core'
import { properties, users, countries } from './core'
import { genderEnum, idDocTypeEnum } from './enums'

export const guests = pgTable('guests', {
  id:                  serial('id').primaryKey(),
  propertyId:          integer('property_id').notNull().references(() => properties.id),
  firstName:           text('first_name').notNull(),
  lastName:            text('last_name').notNull(),
  secondLastName:      text('second_last_name'),
  // 0=sin especificar, 1=Mr, 2=Mrs, 3=Ms
  title:               smallint('title').default(0),
  gender:              genderEnum('gender').notNull().default('unspecified'),
  email:               text('email'),
  phone:               text('phone'),
  dateOfBirth:         date('date_of_birth'),
  nationality:         text('nationality'),          // código ISO-3166 o nombre libre
  // Documento de identidad — campos requeridos para partes de viajeros (SES)
  idDocType:           idDocTypeEnum('id_doc_type'),
  idDocNumber:         text('id_doc_number'),
  idDocSupportNumber:  text('id_doc_support_number'),
  idDocIssuer:         text('id_doc_issuer'),
  idDocIssueDate:      date('id_doc_issue_date'),
  idDocExpiryDate:     date('id_doc_expiry_date'),
  // Dirección
  address1:            text('address1'),
  address2:            text('address2'),
  zipCode:             text('zip_code'),
  city:                text('city'),
  cityIneCode:         text('city_ine_code'),
  addressCountryCode:  char('address_country_code', { length: 2 }),
  countryId:           integer('country_id').references(() => countries.id),
  // Flags
  isVip:               boolean('is_vip').notNull().default(false),
  blacklistReason:     text('blacklist_reason'),
  blacklistSeverity:   text('blacklist_severity'),
  // Estancia
  purposeOfStay:       text('purpose_of_stay'),
  specialInfo1:        text('special_info1'),
  specialInfo2:        text('special_info2'),
  childRelationship:   text('child_relationship'),
  // Valoraciones
  guestRating:         smallint('guest_rating'),   // nuestra valoración del huésped (1-5)
  hotelRating:         smallint('hotel_rating'),   // valoración que nos ha dejado (1-5)
  // Consentimiento RGPD
  emailConsentGiven:   boolean('email_consent_given').notNull().default(false),
  // Multimedia
  photoUrl:            text('photo_url'),
  documentUrl:         text('document_url'),
  // Auditoría
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:           integer('created_by').references(() => users.id),
})

export type Guest = typeof guests.$inferSelect
export type NewGuest = typeof guests.$inferInsert
