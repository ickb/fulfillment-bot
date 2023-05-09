"use strict";

import fs from "fs";
import { RPC } from "@ckb-lumos/rpc";
import { extractDaoDataCompatible } from '@ckb-lumos/common-scripts/lib/dao.js';
import { utils } from "@ckb-lumos/base";
const { ckbHash } = utils;
import { initializeConfig } from "@ckb-lumos/config-manager";
import { addressToScript, sealTransaction, TransactionSkeleton } from "@ckb-lumos/helpers";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { addDefaultCellDeps, addDefaultWitnessPlaceholders, collectCapacity, getLiveCell, indexerReady, readFileToHexString, readFileToHexStringSync, sendTransaction, signTransaction, waitForTransactionConfirmation } from "../lib/index.js";
import { ckbytesToShannons, hexToArrayBuffer, hexToInt, intToHex, intToU64LeHexBytes, intToU128LeHexBytes } from "../lib/util.js";
import { describeTransaction, initializeLab } from "../lumos_template/lab.js";
const CONFIG = JSON.parse(fs.readFileSync("../config.json"));
const DAO = CONFIG.SCRIPTS.DAO;
const ICKB_DOMAIN_LOGIC = CONFIG.SCRIPTS.ICKB_DOMAIN_LOGIC;
const SUDT = CONFIG.SCRIPTS.SUDT;

// CKB Node and CKB Indexer Node JSON RPC URLs.
const NODE_URL = "http://127.0.0.1:8114/";
const INDEXER_URL = "http://127.0.0.1:8114/";

// This is the private key and address which will be used.
const PRIVATE_KEY_1 = "0x67842f5e4fa0edb34c9b4adbe8c3c1f3c737941f7c875d18bc6ec2f80554111d";
const ADDRESS_1 = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvc32wruaxqnk4hdj8yr4yp5u056dkhwtc94sy8q";

// This is the TX fee amount that will be paid in Shannons.
const TX_FEE = 100_000n;

const DEPOSIT_AMOUNT = ckbytesToShannons(50_000n);
const DEPOSIT_QUANTITY = 1;

const AR_0 = 10000000000000000n;
const STANDARD_DEPOSIT_SIZE = ckbytesToShannons(100_000n);

function iCKB_value(unoccupied_capacity, header) {
	const daoData = extractDaoDataCompatible(header.dao);
	const AR_m = BigInt(daoData["ar"]);

	let s = unoccupied_capacity * AR_0 / AR_m;
	if (s > STANDARD_DEPOSIT_SIZE) {
		s = s - (s - STANDARD_DEPOSIT_SIZE) / 10
	}
	return s;
}

function receipt_iCKB_value(receipt_amount, receipt_count, header) {
	return BigInt(receipt_count) * iCKB_value(receipt_amount, header);
}

async function depositPhaseOne(indexer, rpc) {
	console.log("DEPOSIT PHASE ONE\n");

	const header = await rpc.getTipHeader();
	if (iCKB_value(DEPOSIT_AMOUNT, header) > STANDARD_DEPOSIT_SIZE) {
		throw new Error("Deposit too big");
	}

	// Create a transaction skeleton.
	let transaction = TransactionSkeleton();

	// Add the cell deps.
	transaction = addDefaultCellDeps(transaction);
	for (const s of [DAO, ICKB_DOMAIN_LOGIC]) {
		const cellDep = { depType: s.DEP_TYPE, outPoint: { txHash: s.TX_HASH, index: s.INDEX }, };
		transaction = transaction.update("cellDeps", (cellDeps) => cellDeps.push(cellDep));
	}

	// Create DEPOSIT_QUANTITY deposits of DEPOSIT_AMOUNT + occupied capacity.
	const deposit = {
		cellOutput: {
			capacity: intToHex(DEPOSIT_AMOUNT + ckbytesToShannons(82n)),
			lock: {
				codeHash: ICKB_DOMAIN_LOGIC.CODE_HASH,
				hashType: ICKB_DOMAIN_LOGIC.HASH_TYPE,
				args: "0x"
			},
			type: {
				codeHash: DAO.CODE_HASH,
				hashType: DAO.HASH_TYPE,
				args: "0x"
			}
		},
		data: intToU64LeHexBytes(0n)
	};

	for (const _ of Array(DEPOSIT_QUANTITY).keys()) {
		transaction = transaction.update("outputs", (i) => i.push(deposit));
	}

	// Create a receipt cell for three deposits of DEPOSIT_AMOUNT + occupied capacity.
	const receipt = {
		cellOutput: {
			capacity: intToHex(ckbytesToShannons(102n)),
			lock: addressToScript(ADDRESS_1),
			type: {
				codeHash: ICKB_DOMAIN_LOGIC.CODE_HASH,
				hashType: ICKB_DOMAIN_LOGIC.HASH_TYPE,
				args: "0x"
			}
		},
		// DEPOSIT_QUANTITY deposits of DEPOSIT_AMOUNT + occupied capacity.
		data: intToU64LeHexBytes((BigInt(DEPOSIT_QUANTITY) * 2n ** (6n * 8n)) + DEPOSIT_AMOUNT)
	};
	transaction = transaction.update("outputs", (i) => i.push(receipt));

	// Create a cell with ickb lock for SUDT verification in deposit phase two.
	const ickb_owner_lock = {
		cellOutput: {
			capacity: intToHex(ckbytesToShannons(41n)),
			lock: {
				codeHash: ICKB_DOMAIN_LOGIC.CODE_HASH,
				hashType: ICKB_DOMAIN_LOGIC.HASH_TYPE,
				args: "0x"
			},
			type: null
		},
		data: "0x"
	};
	transaction = transaction.update("outputs", (i) => i.push(ickb_owner_lock));

	// Add input capacity cells.
	let outputCapacity = transaction.outputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);
	const capacityRequired = outputCapacity + ckbytesToShannons(61n) + TX_FEE;
	const collectedCells = await collectCapacity(indexer, addressToScript(ADDRESS_1), capacityRequired);
	transaction = transaction.update("inputs", (i) => i.concat(collectedCells.inputCells));

	// Determine the capacity of all input cells.
	let inputCapacity = transaction.inputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);
	outputCapacity = transaction.outputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);

	// Create a change Cell for the remaining CKBytes.
	const changeCapacity = intToHex(inputCapacity - outputCapacity - TX_FEE);
	let change = { cellOutput: { capacity: changeCapacity, lock: addressToScript(ADDRESS_1), type: null }, data: "0x" };
	transaction = transaction.update("outputs", (i) => i.push(change));

	// Add in the witness placeholders.
	transaction = addDefaultWitnessPlaceholders(transaction);

	// Print the details of the transaction to the console.
	describeTransaction(transaction.toJS());

	// Sign the transaction.
	const signedTx = signTransaction(transaction, PRIVATE_KEY_1);

	// Send the transaction to the RPC node.
	const txid = await sendTransaction(NODE_URL, signedTx);
	console.log(`Transaction Sent: ${txid}\n`);

	// Wait for the transaction to confirm.
	await waitForTransactionConfirmation(NODE_URL, txid);
	console.log("\n");

	// Return the out point for the receipt cell so it can be used in the next transaction.
	const receiptOutPoint = { txHash: txid, index: intToHex(DEPOSIT_QUANTITY) };

	// Return the out point for the owner lock cell so it can be used in the next transaction.
	const ownerLockOutPoint = { txHash: txid, index: intToHex(DEPOSIT_QUANTITY + 1) };

	return [receiptOutPoint, ownerLockOutPoint];
}

async function depositPhaseTwo(indexer, rpc, receiptOutPoint, ownerLockOutPoint) {
	console.log("DEPOSIT PHASE TWO\n");

	const transactionProof = await rpc.getTransactionProof([receiptOutPoint.txHash]);
	const header = await rpc.getHeader(transactionProof.blockHash);
	const ickb_sudt_amount = receipt_iCKB_value(DEPOSIT_AMOUNT, DEPOSIT_QUANTITY, header);

	// Create a transaction skeleton.
	let transaction = TransactionSkeleton();

	// Add the cell deps.
	transaction = addDefaultCellDeps(transaction);
	for (const s of [ICKB_DOMAIN_LOGIC, SUDT]) {
		const cellDep = { depType: s.DEP_TYPE, outPoint: { txHash: s.TX_HASH, index: s.INDEX }, };
		transaction = transaction.update("cellDeps", (cellDeps) => cellDeps.push(cellDep));
	}

	// Add the header deps.
	for (const b of [transactionProof.blockHash]) {
		transaction = transaction.update("headerDeps", (headerDeps) => headerDeps.push(b));
	}

	// Add input receipt cell and owner lock cell to the transaction.
	for (const outPoint of [receiptOutPoint, ownerLockOutPoint]) {
		const input = await getLiveCell(NODE_URL, outPoint);
		transaction = transaction.update("inputs", (i) => i.push(input));
	}

	// Create an output sudt cell
	const ickb_sudt = {
		cellOutput: {
			capacity: intToHex(ckbytesToShannons(142n)),
			lock: addressToScript(ADDRESS_1),
			type: {
				codeHash: SUDT.CODE_HASH,
				hashType: SUDT.HASH_TYPE,
				args: utils.computeScriptHash(
					{
						codeHash: ICKB_DOMAIN_LOGIC.CODE_HASH,
						hashType: ICKB_DOMAIN_LOGIC.HASH_TYPE,
						args: "0x"
					}
				)
			}
		},
		data: intToU128LeHexBytes(ickb_sudt_amount)
	};
	transaction = transaction.update("outputs", (i) => i.push(ickb_sudt));

	// Add input capacity cells.
	let outputCapacity = transaction.outputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);
	const capacityRequired = outputCapacity + ckbytesToShannons(61n) + TX_FEE;
	const collectedCells = await collectCapacity(indexer, addressToScript(ADDRESS_1), capacityRequired);
	transaction = transaction.update("inputs", (i) => i.concat(collectedCells.inputCells));

	// Determine the capacity of all input cells.
	let inputCapacity = transaction.inputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);
	outputCapacity = transaction.outputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);

	// Create a change Cell for the remaining CKBytes.
	const changeCapacity = intToHex(inputCapacity - outputCapacity - TX_FEE);
	let change = { cellOutput: { capacity: changeCapacity, lock: addressToScript(ADDRESS_1), type: null }, data: "0x" };
	transaction = transaction.update("outputs", (i) => i.push(change));

	// Add in the witness placeholders.
	transaction = addDefaultWitnessPlaceholders(transaction);

	// Print the details of the transaction to the console.
	describeTransaction(transaction.toJS());

	// Sign the transaction.
	const signedTx = signTransaction(transaction, PRIVATE_KEY_1);

	// Send the transaction to the RPC node.
	const txid = await sendTransaction(NODE_URL, signedTx);
	console.log(`Transaction Sent: ${txid}\n`);

	// Wait for the transaction to confirm.
	await waitForTransactionConfirmation(NODE_URL, txid);
	console.log("\n");

	// Return the out points for the ickb token cell so it can be used in the next transaction.
	const outPoint = { txHash: txid, index: intToHex(DEPOSIT_QUANTITY) }

	return outPoint;
}

async function main() {
	// Initialize the Lumos configuration using ./config.json.
	initializeConfig(CONFIG);

	// Initialize an Indexer instance.
	const indexer = new Indexer(INDEXER_URL, NODE_URL);

	// Initialize our lab.
	await initializeLab(NODE_URL, indexer);
	await indexerReady(indexer);

	const rpc = new RPC(INDEXER_URL, indexer);

	// Create a deposits and receipt cell.
	const [receiptOutPoint, ownerLockOutPoint] = await depositPhaseOne(indexer, rpc);
	await indexerReady(indexer);

	// Transform the receiptOutPoint into iCKB SUDT
	await depositPhaseTwo(indexer, rpc, receiptOutPoint, ownerLockOutPoint);
	await indexerReady(indexer);

	console.log("Execution completed successfully!");
}
main();
