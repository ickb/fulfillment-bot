
import fs from "fs";
import util from "util";
import { Account } from "./utils";
import { secp256k1Blake160 } from "@ckb-lumos/common-scripts";
import { RPC } from "@ckb-lumos/rpc";
import { BI, parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeletonType, sealTransaction } from "@ckb-lumos/helpers";
import { key } from "@ckb-lumos/hd";
import { Config, getConfig } from "@ckb-lumos/config-manager/lib";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { bytes } from "@ckb-lumos/codec";
import { Cell, OutPoint, Script, Transaction, blockchain } from "@ckb-lumos/base";
import { CellCollector, Indexer } from "@ckb-lumos/ckb-indexer";
import { CKBIndexerQueryOptions } from "@ckb-lumos/ckb-indexer/lib/type";
import { PathOrFileDescriptor } from "fs";

// CKB Indexer Node JSON RPC URLs.
export const INDEXER_URL = "http://127.0.0.1:8114/";

export const readFile = util.promisify(fs.readFile)

export async function localConfig(): Promise<Config> {
    const rpc = new RPC(INDEXER_URL, { timeout: 10000 });
    const genesisBlock = await rpc.getBlockByNumber("0x0");

    return {
        PREFIX: "ckt",
        SCRIPTS: {
            SECP256K1_BLAKE160: {
                CODE_HASH: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
                HASH_TYPE: "type",
                TX_HASH: genesisBlock.transactions[1].hash!,
                INDEX: "0x0",
                DEP_TYPE: "depGroup",
            },
            DAO: {
                CODE_HASH: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
                HASH_TYPE: "type",
                TX_HASH: genesisBlock.transactions[0].hash!,
                INDEX: "0x2",
                DEP_TYPE: "code"
            }
        }
    };
}

export function defaultScript(name: string): Script {
    let script_config_data = getConfig().SCRIPTS[name]!;
    return {
        codeHash: script_config_data.CODE_HASH,
        hashType: script_config_data.HASH_TYPE,
        args: "0x"
    };
}

export function ickbSudtScript(): Script {
    let SUDT = getConfig().SCRIPTS.SUDT!;
    let ICKB_DOMAIN_LOGIC = getConfig().SCRIPTS.ICKB_DOMAIN_LOGIC!;
    return {
        codeHash: SUDT.CODE_HASH,
        hashType: SUDT.HASH_TYPE,
        args: computeScriptHash(
            {
                codeHash: ICKB_DOMAIN_LOGIC.CODE_HASH,
                hashType: ICKB_DOMAIN_LOGIC.HASH_TYPE,
                args: "0x"
            }
        )
    }
}

export function addOutputs(transaction: TransactionSkeletonType, roleTag: string, ...outputs: Cell[]) {
    // We are abusing witnesses field to tag the cell output role in the transaction
    if (transaction.outputs.size != transaction.witnesses.size) {
        throw Error("Witnesses and output are of different length");
    }

    let roleTags = Array.from({ length: outputs.length }, () => roleTag)

    transaction = transaction.update("outputs", (o) => o.push(...outputs));
    transaction = transaction.update("witnesses", (w) => w.push(...roleTags));

    return transaction;
}

function popRoleTags(transaction: TransactionSkeletonType) {
    // We are abusing witnesses field to tag the cell output role in the transaction
    if (transaction.outputs.size != transaction.witnesses.size) {
        throw Error("Witnesses and output are of different length");
    }

    let roleTags = transaction.witnesses.toArray();

    // Reset witnesses field to its default value
    transaction = transaction.remove("witnesses");

    return { transaction, roleTags }
}

async function collectCapacity(query: CKBIndexerQueryOptions, capacityRequired: BI) {
    // Initialize an Indexer instance.
    const indexer = new Indexer(INDEXER_URL);
    await indexer.waitForSync();

    const cellCollector = new CellCollector(indexer, query);

    let inputCells = [];
    let inputCapacity = BI.from(0);

    for await (const cell of cellCollector.collect()) {
        inputCells.push(cell);
        inputCapacity = inputCapacity.add(BI.from(cell.cellOutput.capacity));

        if (capacityRequired.lte(inputCapacity))
            break;
    }

    if (inputCapacity.lt(capacityRequired))
        throw new Error("Unable to collect enough cells to fulfill the capacity requirements.");

    return inputCells;
}

async function addCapacity(transaction: TransactionSkeletonType, account: Account) {
    // Get the sum of the outputs.
    const getOutputCapacity = () => transaction.outputs.toArray().reduce(
        (a, c) => a.add(c.cellOutput.capacity), BI.from(0)
    );
    const getInputCapacity = () => transaction.inputs.toArray().reduce(
        (a, c) => a.add(c.cellOutput.capacity), BI.from(0)
    );

    let inputCapacity = getInputCapacity();
    let outputCapacity = getOutputCapacity();

    // Transaction Fee
    const TX_FEE = BI.from(200_000n); // BI.from(100_000n);////////////////////////////////////////////////////////

    if (inputCapacity == outputCapacity.add(TX_FEE)) {
        // do nothing        
    } else {
        if (inputCapacity.lt(outputCapacity.add(parseUnit("61", "ckb")).add(TX_FEE))) {
            // Add input capacity cells to the transaction.
            const query: CKBIndexerQueryOptions = { lock: account.lockScript, type: "empty" };
            const neededCapacity = outputCapacity.add(parseUnit("61", "ckb")).add(TX_FEE).sub(inputCapacity);
            const collectedCells = await collectCapacity(query, neededCapacity);
            transaction = transaction.update("inputs", (i) => i.push(...collectedCells));
            inputCapacity = getInputCapacity();
        }

        // Create a change Cell for the remaining CKBytes.
        const changeCapacity = inputCapacity.sub(outputCapacity).sub(TX_FEE).toHexString();
        let change: Cell = {
            cellOutput: {
                capacity: changeCapacity,
                lock: account.lockScript,
                type: undefined
            },
            data: "0x"
        };

        transaction = addOutputs(transaction, "change", change);
        // outputCapacity = getOutputCapacity();
    }

    return transaction;
}

function addDefaultCellDeps(transaction: TransactionSkeletonType) {
    let secp256k1_blake160 = getConfig().SCRIPTS.SECP256K1_BLAKE160!;

    return transaction.update("cellDeps", (cellDeps) =>
        cellDeps.push({
            outPoint: {
                txHash: secp256k1_blake160.TX_HASH,
                index: secp256k1_blake160.INDEX,
            },
            depType: secp256k1_blake160.DEP_TYPE,
        })
    );
}

function addDefaultWitnessPlaceholders(transaction: TransactionSkeletonType) {
    if (transaction.witnesses.size !== 0)
        throw new Error("This function can only be used on an empty witnesses structure.");

    // Cycle through all inputs adding placeholders for unique locks, and empty witnesses in all other places.
    let secp256k1_blake160 = getConfig().SCRIPTS.SECP256K1_BLAKE160!;
    let uniqueLocks = new Set();
    for (const input of transaction.inputs) {
        let witness = "0x";

        const lockHash = computeScriptHash(input.cellOutput.lock);
        if (!uniqueLocks.has(lockHash)) {
            uniqueLocks.add(lockHash);

            let lock = input.cellOutput.lock;

            if (lock.hashType === secp256k1_blake160.HASH_TYPE && lock.codeHash === secp256k1_blake160.CODE_HASH)
                witness = "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }

        witness = bytes.hexify(blockchain.WitnessArgs.pack({ lock: witness }));
        transaction = transaction.update("witnesses", (w) => w.push(witness));
    }

    return transaction;
}

function signTransaction(transaction: TransactionSkeletonType, PRIVATE_KEY: string) {
    transaction = secp256k1Blake160.prepareSigningEntries(transaction);
    const message = transaction.get("signingEntries").get(0)?.message;
    const Sig = key.signRecoverable(message!, PRIVATE_KEY);
    const tx = sealTransaction(transaction, [Sig]);

    return tx;
}

async function sendTransaction(signedTransaction: Transaction) {
    // Initialize an RPC instance.
    const rpc = new RPC(INDEXER_URL, { timeout: 10000 });

    //Send the transaction
    const txHash = await rpc.sendTransaction(signedTransaction);

    //Wait until the transaction is committed
    for (let i = 0; i < 120; i++) {
        let transactionData = await rpc.getTransaction(txHash);
        switch (transactionData.txStatus.status) {
            case "committed":
                return txHash;
            case "pending":
            case "proposed":
                await new Promise(r => setTimeout(r, 1000));
                break;
            default:
                throw new Error("Unexpected transaction state: " + transactionData.txStatus.status);
        }
    }

    throw new Error("Transaction timed out.");
}

export async function execTx(transaction: TransactionSkeletonType, account: Account) {
    // Add Capacity
    transaction = await addCapacity(transaction, account);

    // Add default Deps
    transaction = addDefaultCellDeps(transaction);

    // Retrieve Output Cells Role Tags
    let roleTags: string[] = [];
    ({ transaction, roleTags } = popRoleTags(transaction));

    // Add in the witness placeholders.
    transaction = addDefaultWitnessPlaceholders(transaction);

    // Sign transaction
    const signedTransaction = signTransaction(transaction, account.privKey);

    // Print the details of the transaction to the console.
    // console.log(JSON.stringify(signedTransaction, undefined, 2));

    // Send transaction
    const txHash = await sendTransaction(signedTransaction);

    // Transform role tags into a map of the outpoints
    const roleTag2OutPoints: { [id: string]: OutPoint[]; } = {};
    roleTags.forEach((roleTag, i) => {
        const index = BI.from(i).toHexString();
        roleTag2OutPoints[roleTag] = [...roleTag2OutPoints[roleTag] || [], { txHash, index }]
    });

    return roleTag2OutPoints;
}

export async function readFileToHexString(filename: PathOrFileDescriptor) {
    const data = await readFile(filename);
    const dataSize = data.length;
    const hexString = "0x" + data.toString("hex");

    return { hexString, dataSize };
}

export async function getLiveCell(rpc: RPC, outPoint: OutPoint) {
    const res = await rpc.getLiveCell(outPoint, true);

    if (res.status !== "live")
        throw new Error(`Live cell not found at out point: ${outPoint.txHash}-${outPoint.index}`);

    return <Cell>{
        cellOutput: res.cell.output,
        outPoint,
        data: res.cell.data.content
    }
}