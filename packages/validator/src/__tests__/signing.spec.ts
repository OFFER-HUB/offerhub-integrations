import { createHash } from 'crypto';
import { Account, Keypair, Networks, Operation, TransactionBuilder, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { signMessage, signTransactionXdr } from '../signing';

/** What SEP-53 says a verifier checks: the signature over sha256("Stellar Signed Message:\n" + message). */
function verifiesSep53(publicKey: string, message: string, signatureBase64: string): boolean {
    const payload = createHash('sha256').update(Buffer.from(`Stellar Signed Message:\n${message}`)).digest();
    return Keypair.fromPublicKey(publicKey).verify(payload, Buffer.from(signatureBase64, 'base64'));
}

describe('signMessage', () => {
    it('produces a SEP-53 signature that verifies against the signer\'s public key', () => {
        const keypair = Keypair.random();
        const challenge = 'a1b2c3d4'.repeat(8);
        expect(verifiesSep53(keypair.publicKey(), challenge, signMessage(keypair, challenge))).toBe(true);
    });

    it('is rejected for a different key', () => {
        const signer = Keypair.random();
        const other = Keypair.random();
        const challenge = 'f'.repeat(64);
        expect(verifiesSep53(other.publicKey(), challenge, signMessage(signer, challenge))).toBe(false);
    });

    it('is rejected for a different message', () => {
        const keypair = Keypair.random();
        expect(verifiesSep53(keypair.publicKey(), 'b'.repeat(64), signMessage(keypair, 'a'.repeat(64)))).toBe(false);
    });
});

describe('signTransactionXdr', () => {
    it('adds a valid signature for the given network', () => {
        const keypair = Keypair.random();
        const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
            fee: BASE_FEE,
            networkPassphrase: Networks.PUBLIC,
        })
            .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
            .setTimeout(30)
            .build();

        const signed = TransactionBuilder.fromXDR(signTransactionXdr(keypair, tx.toXDR(), Networks.PUBLIC), Networks.PUBLIC);
        expect(signed.signatures).toHaveLength(1);
        expect(keypair.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
    });
});
