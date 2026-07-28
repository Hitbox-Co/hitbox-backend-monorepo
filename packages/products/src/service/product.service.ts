import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import {
    PRODUCT_CODE_MAX_ATTEMPTS,
    PRODUCT_CODE_UNIQUE_LENGTH,
    PRODUCT_EVENTS,
    PRODUCTS_ERROR_CODES,
} from '../constants/products.constant';
import type {
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    UpdateProductDto,
} from '../dto/product.dto';
import type {
    ProductHistoryRow,
    ProductRepository,
    ProductWithRelations,
} from '../repository/product.repository';

interface ProductServiceDeps {
    products: ProductRepository;
    eventBus: IEventBus;
    logger: Logger;
}

function generateUniqueSegment(): string {
    let digits = '';
    for (let i = 0; i < PRODUCT_CODE_UNIQUE_LENGTH; i += 1) {
        digits += String(randomInt(0, 10));
    }
    return digits;
}

export class ProductService {
    constructor(private readonly deps: ProductServiceDeps) { }

    async list(query: ListProductsQuery): Promise<PaginatedResult<ProductWithRelations>> {
        const { items, total } = await this.deps.products.findMany(query);
        return {
            items,
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        };
    }

    async getById(id: string): Promise<ProductWithRelations> {
        const product = await this.deps.products.findById(id);
        if (!product) {
            throw AppError.notFound('Product not found', PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return product;
    }

    async getByProductCode(productCode: string): Promise<ProductWithRelations> {
        const product = await this.deps.products.findByProductCode(productCode);
        if (!product) {
            throw AppError.notFound('Product not found', PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return product;
    }

    async getByTagId(tagId: string): Promise<ProductWithRelations> {
        const product = await this.deps.products.findByTagId(tagId);
        if (!product) {
            throw AppError.notFound(
                'No product is registered to this NFC tag',
                PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND,
            );
        }
        return product;
    }

    /** Ownership/price history for the product behind an NFC tag. */
    async getHistoryByTagId(tagId: string): Promise<ProductHistoryRow[]> {
        const product = await this.getByTagId(tagId);
        return this.deps.products.findHistory(product.id);
    }

    async create(dto: CreateProductDto): Promise<ProductWithRelations> {
        const { groupCode, images, collectionId, ...fields } = dto;

        // Random 8-digit prefix + 4-digit group suffix; retry on the (rare)
        // unique-constraint collision instead of pre-checking.
        for (let attempt = 1; attempt <= PRODUCT_CODE_MAX_ATTEMPTS; attempt += 1) {
            const productCode = `${generateUniqueSegment()}${groupCode}`;
            try {
                const product = await this.deps.products.create({
                    ...fields,
                    productCode,
                    ...(collectionId && { collection: { connect: { id: collectionId } } }),
                    ...(images.length > 0 && { images: { create: images } }),
                });
                await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_CREATED, {
                    productId: product.id,
                    productCode: product.productCode,
                });
                return product;
            } catch (error) {
                if (this.isUniqueViolation(error, 'productCode') && attempt < PRODUCT_CODE_MAX_ATTEMPTS) {
                    this.deps.logger.warn({ attempt }, 'productCode collision — retrying');
                    continue;
                }
                if (this.isUniqueViolation(error, 'tagId')) {
                    throw AppError.conflict(
                        'NFC tag is already assigned to another product',
                        PRODUCTS_ERROR_CODES.TAG_TAKEN,
                    );
                }
                throw error;
            }
        }
        throw AppError.conflict(
            'Could not allocate a unique product code',
            PRODUCTS_ERROR_CODES.PRODUCT_CODE_TAKEN,
        );
    }

    async update(id: string, dto: UpdateProductDto): Promise<ProductWithRelations> {
        await this.getById(id); // 404 before update
        const { collectionId, ...fields } = dto;
        try {
            const product = await this.deps.products.update(id, {
                ...fields,
                ...(collectionId !== undefined && {
                    collection: collectionId
                        ? { connect: { id: collectionId } }
                        : { disconnect: true },
                }),
            });
            await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId: id });
            return product;
        } catch (error) {
            if (this.isUniqueViolation(error, 'tagId')) {
                throw AppError.conflict(
                    'NFC tag is already assigned to another product',
                    PRODUCTS_ERROR_CODES.TAG_TAKEN,
                );
            }
            throw error;
        }
    }

    async archive(id: string): Promise<void> {
        await this.getById(id);
        await this.deps.products.archive(id);
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_ARCHIVED, { productId: id });
    }

    private isUniqueViolation(error: unknown, field: string): boolean {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            return false;
        }
        // meta.target may hold Prisma field names or @map'd column names.
        const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const target = error.meta?.target;
        const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
        return names.some((name) => name.includes(field) || name.includes(snake));
    }
}
