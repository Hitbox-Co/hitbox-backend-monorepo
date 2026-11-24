import { AppError } from '@hitbox/shared';
import type { Address } from '@hitbox/database';
import type { Logger } from 'pino';
import { ADDRESS_LIMIT, USERS_ERROR_CODES } from '../constants/users.constant';
import { parseAddressFields, toAddressDto, toAddressInput } from '../dto/address.dto';
import type { AddressDto, CreateAddressDto, UpdateAddressDto } from '../dto/address.dto';
import type { AddressRepository } from '../repository/address.repository';

interface AddressServiceDeps {
    addresses: AddressRepository;
    logger: Logger;
}

/** What checkout needs to know about an address the buyer picked. */
export interface CheckoutAddress {
    id: string;
    countryCode: string;
    state: string | null;
}

export interface ResolvedCheckoutAddresses {
    shipping: CheckoutAddress | null;
    billing: CheckoutAddress | null;
}

/**
 * The buyer's address book.
 *
 * Everything is scoped to the caller: an id that exists but belongs to someone
 * else answers exactly like one that does not exist (404), so the API cannot be
 * used to probe for other people's addresses.
 */
export class AddressService {
    constructor(private readonly deps: AddressServiceDeps) { }

    async list(userId: string): Promise<AddressDto[]> {
        return (await this.deps.addresses.listActive(userId)).map(toAddressDto);
    }

    async get(userId: string, id: string): Promise<AddressDto> {
        return toAddressDto(await this.requireActive(userId, id));
    }

    async create(userId: string, dto: CreateAddressDto): Promise<AddressDto> {
        const result = await this.deps.addresses.create(userId, dto, ADDRESS_LIMIT);
        if (result.kind === 'LIMIT_REACHED') {
            throw AppError.conflict(
                `You can save up to ${result.limit} addresses. Remove one to add another.`,
                USERS_ERROR_CODES.ADDRESS_LIMIT_REACHED,
                { limit: result.limit },
            );
        }
        this.deps.logger.info({ userId, addressId: result.address.id }, 'address saved');
        return toAddressDto(result.address);
    }

    async update(userId: string, id: string, patch: UpdateAddressDto): Promise<AddressDto> {
        const current = await this.requireActive(userId, id);
        // Merge, then validate the whole address: a patch that only changes the
        // country must still leave a PIN/ZIP and state that fit it. Explicit
        // nulls in the patch clear optional fields.
        const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
        const merged = parseAddressFields({ ...toAddressInput(current), ...defined });
        const updated = await this.deps.addresses.update(userId, id, merged);
        if (!updated) throw this.notFound();
        return toAddressDto(updated);
    }

    async archive(userId: string, id: string): Promise<void> {
        if (!(await this.deps.addresses.archive(userId, id))) throw this.notFound();
        this.deps.logger.info({ userId, addressId: id }, 'address archived');
    }

    async setDefault(userId: string, id: string): Promise<AddressDto> {
        const address = await this.deps.addresses.setDefault(userId, id);
        if (!address) throw this.notFound();
        return toAddressDto(address);
    }

    /**
     * Checkout's and the quote's one ownership check.
     *
     * An id that is not the buyer's is **ignored** (resolves to null) exactly as
     * before this API existed: the order simply gets no address. An id that is
     * the buyer's but archived is **rejected**, because the buyer chose
     * something they have since deleted. An address that cannot serve that side
     * (a SHIPPING-only entry as billing, or the reverse) is rejected too.
     */
    async resolveForCheckout(
        buyerId: string,
        ids: { shippingAddressId?: string | null; billingAddressId?: string | null },
    ): Promise<ResolvedCheckoutAddresses> {
        const [shipping, billing] = await Promise.all([
            this.resolveOne(buyerId, ids.shippingAddressId ?? null, 'SHIPPING'),
            this.resolveOne(buyerId, ids.billingAddressId ?? null, 'BILLING'),
        ]);
        return { shipping, billing };
    }

    private async resolveOne(
        buyerId: string,
        id: string | null,
        side: 'SHIPPING' | 'BILLING',
    ): Promise<CheckoutAddress | null> {
        if (!id) return null;
        const row = await this.deps.addresses.findOwned(buyerId, id);
        if (!row) return null;

        if (!row.isActive || row.archivedAt !== null) {
            throw AppError.badRequest(
                'This address was deleted. Pick another one.',
                USERS_ERROR_CODES.ADDRESS_ARCHIVED,
                { addressId: id, use: side },
            );
        }
        if (row.usage !== 'BOTH' && row.usage !== side) {
            throw AppError.badRequest(
                `This address is saved for ${row.usage.toLowerCase()} only.`,
                USERS_ERROR_CODES.ADDRESS_USAGE_MISMATCH,
                { addressId: id, use: side, usage: row.usage },
            );
        }
        return { id: row.id, countryCode: row.countryCode, state: row.state };
    }

    private async requireActive(userId: string, id: string): Promise<Address> {
        const row = await this.deps.addresses.findActive(userId, id);
        if (!row) throw this.notFound();
        return row;
    }

    private notFound(): AppError {
        return AppError.notFound('Address not found.', USERS_ERROR_CODES.ADDRESS_NOT_FOUND);
    }
}
