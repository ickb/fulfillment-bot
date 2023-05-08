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
import { ckbytesToShannons, hexToArrayBuffer, hexToInt, intToHex, intToU64LeHexBytes } from "../lib/util.js";
import { describeTransaction, initializeLab } from "../lumos_template/lab.js";
const CONFIG = JSON.parse(fs.readFileSync("../config.json"));
const DAO = CONFIG.SCRIPTS.DAO;
const ICKB_DOMAIN_LOGIC = CONFIG.SCRIPTS.ICKB_DOMAIN_LOGIC;

// CKB Node and CKB Indexer Node JSON RPC URLs.
const NODE_URL = "http://127.0.0.1:8114/";
const INDEXER_URL = "http://127.0.0.1:8114/";

// This is the private key and address which will be used.
const PRIVATE_KEY_1 = "0x67842f5e4fa0edb34c9b4adbe8c3c1f3c737941f7c875d18bc6ec2f80554111d";
const ADDRESS_1 = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvc32wruaxqnk4hdj8yr4yp5u056dkhwtc94sy8q";

// This is the TX fee amount that will be paid in Shannons.
const TX_FEE = 100_000n;

const DEPOSIT_AMOUNT = ckbytesToShannons(100_000n);
const DEPOSIT_QUANTITY = 1;

async function depositPhaseOne(indexer) {
	console.log("DEPOSIT PHASE ONE\n");

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
	const outPoint = { txHash: txid, index: intToHex(DEPOSIT_QUANTITY) };

	return outPoint;
}

async function depositPhaseTwo(indexer, receiptOutPoint) {
	console.log("DEPOSIT PHASE TWO\n");

	const rpc = new RPC(INDEXER_URL, indexer);
	const transactionProof = await rpc.getTransactionProof([receiptOutPoint.txHash]);
	const header = await rpc.getHeader(transactionProof.blockHash);
	const daoData = extractDaoDataCompatible(header.dao);
	console.log("AR:", daoData["ar"].toString());
	return

	// Create a transaction skeleton.
	let transaction = TransactionSkeleton();

	// Add the cell deps.
	transaction = addDefaultCellDeps(transaction);
	for (const s of [ICKB_DOMAIN_LOGIC]) {
		const cellDep = { depType: s.DEP_TYPE, outPoint: { txHash: s.TX_HASH, index: s.INDEX }, };
		transaction = transaction.update("cellDeps", (cellDeps) => cellDeps.push(cellDep));
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

	// Return the out points for the receipt cell so it can be used in the next transaction.
	const outPoints =
		[
			{ txHash: txid, index: intToHex(DEPOSIT_QUANTITY) },
		];

	return outPoints;
}

async function main() {
	// Initialize the Lumos configuration using ./config.json.
	initializeConfig(CONFIG);

	// Initialize an Indexer instance.
	const indexer = new Indexer(INDEXER_URL, NODE_URL);

	// Initialize our lab.
	await initializeLab(NODE_URL, indexer);
	await indexerReady(indexer);

	// Create a deposits and receipt cell.
	const receiptOutPoint = await depositPhaseOne(indexer);
	await indexerReady(indexer);

	// Transform the receiptOutPoint into iCKB SUDT
	await depositPhaseTwo(indexer, receiptOutPoint);
	await indexerReady(indexer);

	console.log("Execution completed successfully!");
}
main();
