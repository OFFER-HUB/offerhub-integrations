import {
    BLINDPAY_CORRIDORS,
    BLINDPAY_CORRIDOR_CURRENCY,
    isSupportedCorridor,
    isValidRailForCountry,
    missingRailDetails,
    requiresEnhancedKyc,
} from '../corridors';

describe('BlindPay corridors', () => {
    it('covers the four LATAM corridors BlindPay supports, and not Peru, Chile or Costa Rica', () => {
        expect(Object.keys(BLINDPAY_CORRIDORS).sort()).toEqual(['AR', 'BR', 'CO', 'MX']);
        for (const country of ['PE', 'CL', 'CR']) expect(isSupportedCorridor(country)).toBe(false);
    });

    it('settles each corridor in its local currency', () => {
        expect(BLINDPAY_CORRIDOR_CURRENCY).toEqual({ BR: 'BRL', MX: 'MXN', AR: 'ARS', CO: 'COP' });
    });

    it('accepts only the rails of the right country', () => {
        expect(isValidRailForCountry('MX', 'SPEI_BITSO')).toBe(true);
        expect(isValidRailForCountry('MX', 'PIX')).toBe(false);
        expect(isValidRailForCountry('BR', 'TED')).toBe(true);
        expect(isValidRailForCountry('PE', 'SPEI_BITSO')).toBe(false);
    });

    it('needs the enhanced KYC tier only for Colombia', () => {
        expect(requiresEnhancedKyc('CO')).toBe(true);
        expect(['BR', 'MX', 'AR'].some(requiresEnhancedKyc)).toBe(false);
    });

    it('names the rail details an account is missing', () => {
        expect(missingRailDetails('SPEI_BITSO', {})).toEqual(['spei_protocol']);
        expect(missingRailDetails('SPEI_BITSO', { spei_protocol: 'clabe' })).toEqual([]);
        expect(missingRailDetails('PIX', { pix_key: '' })).toEqual(['pix_key']);
        expect(missingRailDetails('UNKNOWN_RAIL', null)).toEqual([]);
    });
});
