// Code taken as it is from:
// https://raw.githubusercontent.com/ckb-js/lumos/develop/packages/codec/src/number/uint.ts

import { BI, BIish } from "@ckb-lumos/bi";
import { createFixedBytesCodec } from "@ckb-lumos/codec/lib/base";
import { CodecBaseParseError } from "@ckb-lumos/codec/lib/error";


function assertNumberRange(
    value: BIish,
    min: BIish,
    max: BIish,
    typeName: string
): void {
    value = BI.from(value);

    if (value.lt(min) || value.gt(max)) {
        throw new CodecBaseParseError(
            `Value must be between ${min.toString()} and ${max.toString()}, but got ${value.toString()}`,
            typeName
        );
    }
}

export const createUintBICodec = (byteLength: number, littleEndian = false) => {
    const max = BI.from(1)
        .shl(byteLength * 8)
        .sub(1);

    return createFixedBytesCodec<BI, BIish>({
        byteLength,
        pack(biIsh) {
            let endianType: "LE" | "BE" | "" = littleEndian ? "LE" : "BE";

            if (byteLength <= 1) {
                endianType = "";
            }
            const typeName = `Uint${byteLength * 8}${endianType}`;
            if (typeof biIsh === "number" && !Number.isSafeInteger(biIsh)) {
                throw new CodecBaseParseError(
                    `${biIsh} is not a safe integer`,
                    typeName
                );
            }

            let num = BI.from(biIsh);
            assertNumberRange(num, 0, max, typeName);

            const result = new DataView(new ArrayBuffer(byteLength));

            for (let i = 0; i < byteLength; i++) {
                if (littleEndian) {
                    result.setUint8(i, num.and(0xff).toNumber());
                } else {
                    result.setUint8(byteLength - i - 1, num.and(0xff).toNumber());
                }
                num = num.shr(8);
            }

            return new Uint8Array(result.buffer);
        },
        unpack: (buf) => {
            const view = new DataView(Uint8Array.from(buf).buffer);
            let result = BI.from(0);

            for (let i = 0; i < byteLength; i++) {
                if (littleEndian) {
                    result = result.or(BI.from(view.getUint8(i)).shl(i * 8));
                } else {
                    result = result.shl(8).or(view.getUint8(i));
                }
            }

            return result;
        },
    });
};