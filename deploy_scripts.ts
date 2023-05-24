import { RPC } from "@ckb-lumos/rpc";
import { BI, parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Config, ScriptConfig, ScriptConfigs, } from "@ckb-lumos/config-manager/lib";
import { molecule } from "@ckb-lumos/codec";
import { Cell, OutPoint, blockchain, } from "@ckb-lumos/base";
import { INDEXER_URL, addOutputs, defaultScript, readFile, readFileToHexString } from "./lib";
import { ckbHash } from "@ckb-lumos/base/lib/utils";


export async function deployCode(dataFiles: string[], transaction_?: TransactionSkeletonType) {
    let transaction = transaction_ ?? TransactionSkeleton();

    for (const data_file_1 of dataFiles) {
        const { hexString: hexString1, dataSize: dataSize1 } = await readFileToHexString(data_file_1);
        const output1: Cell = {
            cellOutput: {
                capacity: parseUnit((41 + dataSize1).toString(), "ckb").toHexString(),
                lock: defaultScript("SECP256K1_BLAKE160"),
                type: undefined
            },
            data: hexString1
        };
        transaction = addOutputs(transaction, "code", output1);
    }

    return transaction;
}

export async function createDepGroup(codeOutPoints: OutPoint[], transaction_?: TransactionSkeletonType) {
    let transaction = transaction_ ?? TransactionSkeleton();

    const rpc = new RPC(INDEXER_URL, { timeout: 10000 });
    const genesisBlock = await rpc.getBlockByNumber("0x0");

    const outPoints: OutPoint[] = [
        ...Array.from(
            { length: 3 },//SECP256K1_BLAKE160_SIGHASH_ALL, DAO, SECP256K1_DATA
            (_, i) => {
                return {
                    txHash: genesisBlock.transactions[0].hash!,
                    index: BI.from(i + 1).toHexString(),
                }
            },
        ),
        ...codeOutPoints,
    ];

    let packedOutPoints = molecule.vector(blockchain.OutPoint).pack(outPoints);
    let hexOutPoints = "0x" + Buffer.from(packedOutPoints).toString('hex');
    const output1: Cell = {
        cellOutput: {
            capacity: parseUnit((41 + hexOutPoints.length / 2 - 1).toString(), "ckb").toHexString(),
            lock: defaultScript("SECP256K1_BLAKE160"),
            type: undefined
        },
        data: hexOutPoints
    };

    return addOutputs(transaction, "depGroup", output1);
}

export async function updatedLocalConfig(dataFiles: string[], depGroupOutPoint: OutPoint): Promise<Config> {

    const defaultScriptConfig: ScriptConfig = {
        CODE_HASH: "",
        HASH_TYPE: "data",
        TX_HASH: depGroupOutPoint.txHash,
        INDEX: depGroupOutPoint.index,
        DEP_TYPE: "depGroup"
    }

    let scripts: ScriptConfigs = {}
    for (const filepath of dataFiles) {
        scripts[filepath.replace("./files/", "").toUpperCase()] = {
            ...defaultScriptConfig,
            CODE_HASH: ckbHash(await readFile(filepath)),
            HASH_TYPE: "data",
        }
    }

    return {
        PREFIX: "ckt",
        SCRIPTS: {
            SECP256K1_BLAKE160: {
                ...defaultScriptConfig,
                CODE_HASH: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
                HASH_TYPE: "type",
            },
            DAO: {
                ...defaultScriptConfig,
                CODE_HASH: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
                HASH_TYPE: "type",
            },
            ...scripts
        }
    };
}
