import type { Address, AddressBookUsage, AddressLabel } from '@hitbox/database';
import { z } from 'zod';
import { normalizePostalCode, validateRegion } from '../domain/address-rules';

/** The labels the app shows; stored as the `AddressLabel` enum. */
export const ADDRESS_LABELS = ['Home', 'Work', 'Other'] as const;
export type AddressLabelName = (typeof ADDRESS_LABELS)[number];

export const ADDRESS_USAGES = ['SHIPPING', 'BILLING', 'BOTH'] as const;

const LABEL_TO_DB: Record<AddressLabelName, AddressLabel> = {
    Home: 'HOME',
    Work: 'WORK',
    Other: 'OTHER',
};
const LABEL_FROM_DB: Record<AddressLabel, AddressLabelName> = {
    HOME: 'Home',
    WORK: 'Work',
    OTHER: 'Other',
};

/** Blank optional text is "not set", never an empty string. */
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .nullish()
        .transform((value) => (value ? value : null));

const PHONE = /^\+?[0-9][0-9 ()\-.]{4,19}$/;

/**
 * The field rules. Country-specific ones (PIN/ZIP and state, see
 * `address-rules.ts`) run in `superRefine` against the normalized values, so
 * one 422 lists every problem at once.
 */
const addressShape = {
    label: z.enum(ADDRESS_LABELS),
    recipientName: z.string().trim().min(1).max(100),
    line1: z.string().trim().min(1).max(200),
    line2: optionalText(200),
    city: z.string().trim().min(1).max(100),
    state: z
        .string()
        .trim()
        .max(100)
        .nullish()
        .transform((value) => (value ? value.toUpperCase() : null)),
    postalCode: z.string().trim().min(2).max(20),
    countryCode: z
        .string()
        .trim()
        .length(2)
        .transform((value) => value.toUpperCase()),
    phone: z
        .string()
        .trim()
        .regex(PHONE, 'Must look like a phone number, e.g. "+919800000000".')
        .nullish()
        .transform((value) => value ?? null),
    usage: z.enum(ADDRESS_USAGES),
};

const addressFieldsSchema = z
    .object(addressShape)
    .strict()
    .transform((value) => ({
        ...value,
        postalCode: normalizePostalCode(value.countryCode, value.postalCode),
    }))
    .superRefine((value, ctx) => {
        for (const issue of validateRegion(value)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
        }
    });

export type AddressFields = z.output<typeof addressFieldsSchema>;

/** `POST /users/me/addresses`: `usage` defaults to BOTH. */
export const createAddressSchema = z.preprocess(
    (body) =>
        body && typeof body === 'object' && !Array.isArray(body) && !('usage' in body)
            ? { ...body, usage: 'BOTH' }
            : body,
    addressFieldsSchema,
);
export type CreateAddressDto = AddressFields;

/**
 * `PATCH /users/me/addresses/:id`: send only what changes. The service merges
 * it over the saved address and re-validates the *whole* result, so changing
 * `countryCode` alone is rejected if the saved PIN code no longer fits.
 */
export const updateAddressSchema = z
    .object(addressShape)
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: 'Send at least one field to change.',
    });
export type UpdateAddressDto = z.input<typeof updateAddressSchema>;

/** Re-validates a merged address (saved values plus a patch) like a create. */
export function parseAddressFields(raw: unknown): AddressFields {
    return addressFieldsSchema.parse(raw);
}

/** A malformed id is a 404 like an unknown one, not a database error. */
export const addressIdParamSchema = z.object({
    id: z.string().uuid().catch('00000000-0000-0000-0000-000000000000'),
});

/** The shape the app receives: orders' `BuyerAddress` plus the book fields. */
export interface AddressDto {
    id: string;
    label: AddressLabelName;
    recipientName: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string;
    countryCode: string;
    phone: string | null;
    isDefault: boolean;
    usage: AddressBookUsage;
    createdAt: Date;
}

export function toAddressDto(row: Address): AddressDto {
    return {
        id: row.id,
        label: LABEL_FROM_DB[row.label],
        recipientName: row.recipientName,
        line1: row.line1,
        line2: row.line2,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        countryCode: row.countryCode,
        phone: row.phone,
        isDefault: row.isDefault,
        usage: row.usage,
        createdAt: row.createdAt,
    };
}

/** Columns for a create or update from validated fields. */
export function toAddressColumns(fields: AddressFields) {
    return {
        label: LABEL_TO_DB[fields.label],
        labelCustom: null,
        recipientName: fields.recipientName,
        line1: fields.line1,
        line2: fields.line2,
        city: fields.city,
        state: fields.state,
        postalCode: fields.postalCode,
        countryCode: fields.countryCode,
        phone: fields.phone,
        usage: fields.usage,
    };
}

/** The saved address as raw input, ready to be merged with a patch. */
export function toAddressInput(row: Address) {
    return {
        label: LABEL_FROM_DB[row.label],
        recipientName: row.recipientName,
        line1: row.line1,
        line2: row.line2,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        countryCode: row.countryCode,
        phone: row.phone,
        usage: row.usage,
    };
}
