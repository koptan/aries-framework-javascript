import type { KeyType } from './KeyType'

import { Buffer, MultiBaseEncoder, TypedArrayEncoder, VarintEncoder } from '../utils'

import { getKeyTypeByMultiCodecPrefix, getMultiCodecPrefixByKeytype } from './multiCodecKey'

export class Key {
  public readonly publicKey: Buffer
  public readonly keyType: KeyType

  public constructor(publicKey: Uint8Array, keyType: KeyType) {
    this.publicKey = Buffer.from(publicKey)
    this.keyType = keyType
  }

  public static fromPublicKey(publicKey: Uint8Array, keyType: KeyType) {
    return new Key(Buffer.from(publicKey), keyType)
  }

  public static fromPublicKeyBase58(publicKey: string, keyType: KeyType) {
    const publicKeyBytes = TypedArrayEncoder.fromBase58(publicKey)

    return Key.fromPublicKey(publicKeyBytes, keyType)
  }

  public static fromFingerprint(fingerprint: string) {
    const { data } = MultiBaseEncoder.decode(fingerprint)
    const [code, byteLength] = VarintEncoder.decode(data)

    const publicKey = Buffer.from(data.slice(byteLength))
    const keyType = getKeyTypeByMultiCodecPrefix(code)

    return new Key(publicKey, keyType)
  }

  public get prefixedPublicKey() {
    const multiCodecPrefix = getMultiCodecPrefixByKeytype(this.keyType)

    // Create Buffer with length of the prefix bytes, then use varint to fill the prefix bytes
    const prefixBytes = VarintEncoder.encode(multiCodecPrefix)

    // Combine prefix with public key
    return Buffer.concat([prefixBytes, this.publicKey])
  }

  public get fingerprint() {
    return `z${TypedArrayEncoder.toBase58(this.prefixedPublicKey)}`
  }

  public get publicKeyBase58() {
    return TypedArrayEncoder.toBase58(this.publicKey)
  }
}
