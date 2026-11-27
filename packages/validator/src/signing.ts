import { createHash } from 'crypto';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Local stand-ins for what Stellar Wallets Kit does in the browser.
 */

const SEP53_PREFIX = 'Stellar Signed Message:\n';

/** SEP-53 message signature, base64 — what `kit.signMessage()` returns. */
export function signMessage(keypair: Keypair, message: string): string {
    const payload = createHash('sha256').update(Buffer.from(SEP53_PREFIX + message)).digest();
    return keypair.sign(payload).toString('base64');
}

/** Signs an unsigned transaction XDR — what `kit.signTransaction()` returns. */
export function signTransactionXdr(keypair: Keypair, unsignedXdr: string, networkPassphrase: string): string {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
}
