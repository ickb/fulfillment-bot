import { RPC } from "@ckb-lumos/rpc";
import { BI, parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Header, OutPoint } from "@ckb-lumos/base";
import { INDEXER_URL, defaultScript, addOutputs, getLiveCell, ickbSudtScript } from "./lib";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { Account } from "./utils";

const AR_0 = BI.from("10000000000000000");
export const ICKB_SOFT_CAP_PER_DEPOSIT = parseUnit("100000", "ckb");

export function ickb_value(ckb_unoccupied_capacity: BI, header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    let ickb_amount = ckb_unoccupied_capacity.mul(AR_0).div(AR_m);
    if (ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickb_amount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickb_amount = ickb_amount.sub(ickb_amount.sub(ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }

    return ickb_amount;
}

export function receipt_ickb_value(receipt_amount: BI, receipt_count: BI, header: Header) {
    return ickb_value(receipt_amount, header).mul(receipt_count);
}

export function ckb_soft_cap_per_deposit(header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    return ICKB_SOFT_CAP_PER_DEPOSIT.mul(AR_m).div(AR_0).add(1);
}

const DEPOSIT_AMOUNT_LIMIT = BI.from(2n ** (6n * 8n));

export function depositPhaseOne(depositAmount: BI, depositQuantity: number, account: Account, transaction_?: TransactionSkeletonType) {
    let transaction = transaction_ ?? TransactionSkeleton();

    if (depositAmount.gte(DEPOSIT_AMOUNT_LIMIT)) {
        throw Error(`depositAmount is ${depositAmount}, but should be less than ${DEPOSIT_AMOUNT_LIMIT.toString()}`);
    }

    if (depositQuantity > 61) {
        throw Error(`depositQuantity is ${depositQuantity}, but should be less than 62`);
    }

    // Create depositQuantity deposits of occupied capacity + depositAmount.
    const deposit = {
        cellOutput: {
            capacity: parseUnit("82", "ckb").add(depositAmount).toHexString(),
            lock: defaultScript("ICKB_DOMAIN_LOGIC"),
            type: defaultScript("DAO"),
        },
        data: hexify(Uint64LE.pack(0))
    };

    transaction = addOutputs(transaction, "deposit", ...Array.from({ length: depositQuantity }, () => deposit));

    // Create a receipt cell for depositQuantity deposits of depositAmount + occupied capacity.
    const receipt = {
        cellOutput: {
            capacity: parseUnit("102", "ckb").toHexString(),
            lock: account.lockScript,
            type: defaultScript("ICKB_DOMAIN_LOGIC")
        },
        // depositQuantity deposits of depositAmount + occupied capacity.
        // (( 2n ** (6n * 8n)) * depositQuantity) + depositAmount
        data: hexify(Uint64LE.pack(DEPOSIT_AMOUNT_LIMIT.mul(depositQuantity).add(depositAmount)))//modify script?///////
    };
    transaction = addOutputs(transaction, "receipt", receipt);

    // Create a cell with ickb lock for SUDT verification in deposit phase two.
    const ownerLock = {
        cellOutput: {
            capacity: parseUnit("41", "ckb").toHexString(),
            lock: defaultScript("ICKB_DOMAIN_LOGIC"),
            type: undefined//use SECP256K1_BLAKE160?/////////////////////////////////////////////////////////
        },
        data: "0x"
    };
    transaction = addOutputs(transaction, "ownerLock", ownerLock);

    if (transaction.outputs.size > 63) {
        throw Error("NervosDAO transactions are limited to 64 outputs");
    }

    return transaction;
}

export async function depositPhaseTwo(receiptOutPoints: OutPoint[], ownerLockOutPoint: OutPoint, transaction_?: TransactionSkeletonType) {
    let transaction = transaction_ ?? TransactionSkeleton();

    const rpc = new RPC(INDEXER_URL, { timeout: 10000 });

    const headerDeps = new Set<string>();
    for (const outPoint of receiptOutPoints) {
        const cell = await getLiveCell(rpc, outPoint);
        const transactionProof = await rpc.getTransactionProof([outPoint.txHash]);
        const header = await rpc.getHeader(transactionProof.blockHash);
        const receiptBlockHash = transactionProof.blockHash;
        headerDeps.add(receiptBlockHash);

        const data = BI.from(cell.data);
        const depositAmount = data.mod(DEPOSIT_AMOUNT_LIMIT);
        const depositQuantity = data.div(DEPOSIT_AMOUNT_LIMIT);

        // Create an output sudt cell
        const ickbSudt = {
            cellOutput: {
                capacity: parseUnit("142", "ckb").toHexString(),
                lock: cell.cellOutput.lock,
                type: ickbSudtScript()
            },
            data: hexify(
                Uint128LE.pack(
                    receipt_ickb_value(depositAmount, depositQuantity, header)
                )
            )
        };

        transaction = transaction.update("inputs", (i) => i.push(cell));
        transaction = addOutputs(transaction, "ickbSudt", ickbSudt);
    }

    const cell = await getLiveCell(rpc, ownerLockOutPoint);
    transaction = transaction.update("inputs", (i) => i.push(cell));

    transaction = transaction.update("headerDeps", (h) => h.push(...headerDeps));

    return transaction;
}