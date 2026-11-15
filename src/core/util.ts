/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Utilitários internos: dinheiro, datas (America/Sao_Paulo), documentos, crypto e validação
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { UnsupportedOperationError, ValidationError } from './errors';
import type { CreateChargeInput, GatewayCapabilities, GatewayId } from './types';

// ---------------------------------------------------------------- dinheiro

/** 150 -> 1.5 (para provedores que usam decimal: Mercado Pago, Asaas) */
export const centsToDecimal = (cents: number): number => Number((cents / 100).toFixed(2));

/** 1.5 -> 150 */
export const decimalToCents = (value: number | string | null | undefined): number => {
    const n = typeof value === 'string' ? Number(value) : (value ?? 0);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// ---------------------------------------------------------------- datas

/** Brasil sem horário de verão desde 2019: São Paulo = UTC-03:00 fixo */
const SP_OFFSET_MS = -3 * 60 * 60 * 1000;

/** ISO-8601 com offset -03:00 e milissegundos: "2026-11-15T10:00:00.000-03:00" */
export function toSaoPauloIso(d: Date, withMs = true): string {
    const iso = new Date(d.getTime() + SP_OFFSET_MS).toISOString().replace('Z', '-03:00');
    return withMs ? iso : iso.replace(/\.\d{3}(?=-03:00$)/, '');
}

/** Data civil em São Paulo: "2026-11-15" */
export const toSaoPauloDate = (d: Date): string => toSaoPauloIso(d).slice(0, 10);

export const parseDate = (v: unknown): Date | undefined => {
    if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    // Datas sem hora ("2026-11-15") são interpretadas como fim do dia em São Paulo
    const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59-03:00`) : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
};

export const unixToDate = (s: unknown): Date | undefined => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : undefined);

// ---------------------------------------------------------------- documentos / telefone

export const onlyDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/** "+55 (51) 99999-9999" -> { country: '55', area: '51', number: '999999999' } */
export function parseBrPhone(phone: string | undefined): { country: string; area: string; number: string } | undefined {
    let d = onlyDigits(phone);
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
    if (d.length < 10 || d.length > 11) return undefined;
    return { country: '55', area: d.slice(0, 2), number: d.slice(2) };
}

/** "Fulano de Tal Silva" -> { first: 'Fulano', last: 'de Tal Silva' } */
export function splitName(name: string): { first: string; last: string } {
    const parts = name.trim().split(/\s+/);
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------- crypto

export const hmacSha256Hex = (secret: string, data: string): string => createHmac('sha256', secret).update(data, 'utf8').digest('hex');

export const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** Comparação em tempo constante (não vaza, pelo tempo de resposta, quantos caracteres batem) */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) {
        timingSafeEqual(ba, ba); // gasta o mesmo tempo mesmo com tamanhos diferentes
        return false;
    }
    return timingSafeEqual(ba, bb);
}

export const newUuid = (): string => randomUUID();

/** Cabeçalhos com nomes em minúsculas (frameworks entregam com caixas diferentes) */
export function lowerHeaders(h: Record<string, string | undefined>): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
    return out;
}

export function parseJsonBody(gateway: GatewayId, rawBody: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(rawBody);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
        /* cai no erro abaixo */
    }
    throw new ValidationError(`Webhook ${gateway}: corpo não é um JSON válido`, 'rawBody');
}

// ---------------------------------------------------------------- validação

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

/**
 * Validação comum de `createCharge` (chamada por todos os adapters antes de qualquer requisição).
 * - `allowZero`: só a cortesia aceita valor zero.
 */
export function validateChargeInput(
    gateway: GatewayId,
    capabilities: GatewayCapabilities,
    input: CreateChargeInput,
    opts: { allowZero?: boolean; currencies?: string[] } = {},
): void {
    if (!input || typeof input !== 'object') throw new ValidationError('Entrada da cobrança ausente');
    if (!capabilities.methods.includes(input.method)) {
        throw new UnsupportedOperationError(gateway, `createCharge:${input.method}`, `Gateway "${gateway}" não suporta o método ${input.method}`);
    }
    const min = opts.allowZero ? 0 : 1;
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < min) {
        throw new ValidationError(`amountCents deve ser inteiro >= ${min} (centavos)`, 'amountCents');
    }
    const currency = input.currency ?? 'BRL';
    const currencies = opts.currencies ?? ['BRL'];
    if (!currencies.includes(currency.toUpperCase())) {
        throw new ValidationError(`Moeda ${currency} não suportada por "${gateway}"`, 'currency');
    }
    if (!isNonEmpty(input.description)) throw new ValidationError('description é obrigatório', 'description');
    if (!isNonEmpty(input.externalReference)) throw new ValidationError('externalReference é obrigatório', 'externalReference');
    if (!isNonEmpty(input.idempotencyKey)) throw new ValidationError('idempotencyKey é obrigatório', 'idempotencyKey');
    if (!input.customer || !isNonEmpty(input.customer.name)) throw new ValidationError('customer.name é obrigatório', 'customer.name');
    if (!isNonEmpty(input.customer.email)) throw new ValidationError('customer.email é obrigatório', 'customer.email');
    if (input.expiresAt !== undefined && (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()))) {
        throw new ValidationError('expiresAt inválido', 'expiresAt');
    }
    if (input.items?.length) {
        let sum = 0;
        for (const [i, it] of input.items.entries()) {
            if (!isNonEmpty(it.title)) throw new ValidationError(`items[${i}].title é obrigatório`, `items.${i}.title`);
            if (!Number.isSafeInteger(it.quantity) || it.quantity < 1) throw new ValidationError(`items[${i}].quantity inválido`, `items.${i}.quantity`);
            if (!Number.isSafeInteger(it.unitAmountCents) || it.unitAmountCents < 0) {
                throw new ValidationError(`items[${i}].unitAmountCents inválido`, `items.${i}.unitAmountCents`);
            }
            sum += it.quantity * it.unitAmountCents;
        }
        if (sum !== input.amountCents && !opts.allowZero) {
            throw new ValidationError(`Soma dos itens (${sum}) difere de amountCents (${input.amountCents})`, 'items');
        }
    }
}

/** Itens da cobrança; sem itens = 1 item com a descrição e o valor total */
export const chargeItems = (input: CreateChargeInput) =>
    input.items?.length
        ? input.items
        : [{ id: input.externalReference, title: input.description, quantity: 1, unitAmountCents: input.amountCents }];

export function assertRefundAmount(amountCents: number | undefined): void {
    if (amountCents !== undefined && (!Number.isSafeInteger(amountCents) || amountCents < 1)) {
        throw new ValidationError('amountCents do estorno deve ser inteiro >= 1', 'amountCents');
    }
}

export function assertExternalId(externalId: string): void {
    if (!isNonEmpty(externalId)) throw new ValidationError('externalId é obrigatório', 'externalId');
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : typeof v === 'number' ? String(v) : undefined);
