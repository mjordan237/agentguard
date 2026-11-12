import { PublicKey } from "@solana/web3.js";

/**
 * A Borsh reader driven by an Anchor (spec 0.1.0) IDL's type table. Used for programs whose arguments the
 * clear-sign decoder cannot read (enums, variable-length plans), such as Jupiter's route plan. Every read is
 * bounds-checked and a vector's declared length is capped, so crafted data fails with an error instead of
 * allocating or reading past the buffer.
 */

export type IdlType = string | { vec: IdlType } | { option: IdlType } | { array: [IdlType, number] } | { defined: { name: string } };
interface IdlField { name: string; type: IdlType }
interface IdlTypeDef { name: string; type: { kind: "struct"; fields?: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: IdlField[] }[] } }

/** Far above any real route; a declared length beyond it is malformed data, not a large plan. */
const MAX_VEC_LENGTH = 64;
const MAX_BYTES_LENGTH = 1232;

export class BorshReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array, private readonly types: Map<string, IdlTypeDef>) {}

  get remaining(): number { return this.data.length - this.offset; }

  private take(length: number): Uint8Array {
    if (length > this.remaining) throw new RangeError(`data ends ${length - this.remaining} byte(s) early at offset ${this.offset}`);
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private uint(bytes: number): bigint {
    const slice = this.take(bytes);
    let value = 0n;
    for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(slice[i]!);
    return value;
  }

  private length(max: number): number {
    const length = Number(this.uint(4));
    if (length > max) throw new RangeError(`declared length ${length} exceeds ${max}`);
    return length;
  }

  read(type: IdlType): unknown {
    if (typeof type === "string") {
      switch (type) {
        case "u8": return Number(this.uint(1));
        case "u16": return Number(this.uint(2));
        case "u32": return Number(this.uint(4));
        case "u64": return this.uint(8);
        case "u128": return this.uint(16);
        case "bool": {
          const byte = this.take(1)[0];
          if (byte !== 0 && byte !== 1) throw new RangeError(`bool byte is ${byte}`);
          return byte === 1;
        }
        case "pubkey": return new PublicKey(this.take(32)).toBase58();
        case "bytes": return Buffer.from(this.take(this.length(MAX_BYTES_LENGTH))).toString("hex");
        default: throw new TypeError(`unsupported IDL type ${type}`);
      }
    }
    if ("vec" in type) return Array.from({ length: this.length(MAX_VEC_LENGTH) }, () => this.read(type.vec));
    if ("option" in type) {
      const tag = this.take(1)[0];
      if (tag !== 0 && tag !== 1) throw new RangeError(`option tag is ${tag}`);
      return tag === 0 ? null : this.read(type.option);
    }
    if ("array" in type) return Array.from({ length: type.array[1] }, () => this.read(type.array[0]));
    const definition = this.types.get(type.defined.name);
    if (!definition) throw new TypeError(`type ${type.defined.name} is not in the IDL`);
    if (definition.type.kind === "struct") return this.fields(definition.type.fields ?? []);
    const index = Number(this.uint(1));
    const variant = definition.type.variants[index];
    if (!variant) throw new RangeError(`${type.defined.name} has no variant ${index}`);
    return variant.fields?.length ? { [variant.name]: this.fields(variant.fields) } : variant.name;
  }

  fields(fields: IdlField[]): Record<string, unknown> {
    return Object.fromEntries(fields.map((field) => [field.name, this.read(field.type)]));
  }
}

export function typeTable(idl: { types?: IdlTypeDef[] }): Map<string, IdlTypeDef> {
  return new Map((idl.types ?? []).map((definition) => [definition.name, definition]));
}
